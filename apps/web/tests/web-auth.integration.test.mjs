import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import { TextEncoder } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../../api/dist/application.js';
import { hashPassword } from '../../api/dist/identity/password-hasher.js';
import { hashSessionToken } from '../../api/dist/identity/session-token.js';
import { resetRateLimitState } from '../../api/tests/support/rate-limit-state.mjs';
import { clearOrphanSecurityEvents } from '../../api/tests/support/event-cleanup.mjs';

/**
 * Stage 2.8 end-to-end authentication through the real chain:
 *
 *   HTTP client -> real `next start` (production build, same-origin proxy) -> real Nest API -> PostgreSQL + Redis
 *
 * Nothing in the chain is stubbed. The client is a Node `fetch` with a small explicit cookie jar and
 * explicit `Origin` control: no browser is available in this repository's toolchain, and a browser would
 * not let a test send a forged `Origin` or a duplicated cookie in any case. What this proves is the
 * server-observable contract - which origin sets the cookie, which headers cross the proxy, and what the
 * API then does with them. It does not prove browser rendering behaviour.
 */

const PASSWORD = 'correct horse battery staple';
const COOKIE = 'tsms_session';
const EVIL = 'https://evil.example';
const integrationEnv = parseIntegrationEnvironment(process.env);
const webRoot = resolve(import.meta.dirname, '..');
const nextBin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');

let db, api, apiUrl, web, webOrigin, deadWeb, ids;
const apiLog = [];
let consoleError;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

async function startWeb(port, apiOrigin) {
  const record = { output: '', child: null, origin: `http://127.0.0.1:${port}` };
  record.child = spawn(
    process.execPath,
    [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        TSMS_API_ORIGIN: apiOrigin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  for (const stream of [record.child.stdout, record.child.stderr]) {
    stream.on('data', (data) => {
      record.output = (record.output + data.toString()).slice(-20_000);
    });
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (record.child.exitCode !== null) throw new Error(`next exited: ${record.output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return record;
    } catch {
      /* not accepting connections yet */
    }
    if (Date.now() > deadline) throw new Error(`next did not start: ${record.output}`);
    await delay(150);
  }
}

async function stopWeb(record) {
  if (!record || record.child.exitCode !== null) return;
  record.child.kill();
  await once(record.child, 'exit').catch(() => undefined);
}

beforeAll(async () => {
  const databaseUrl = assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  const webPort = await freePort();
  webOrigin = `http://127.0.0.1:${webPort}`;
  // The API trusts exactly the web origin and nothing else: the proxy is not a trusted party, the
  // browser's Origin is. Anything the web server forwards must still match this list.
  api = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: integrationEnv.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [webOrigin],
    API_RATE_LIMIT_HMAC_SECRET: 'stage28_web_integration_rate_limit_key_0123456789',
  });
  await api.listen(0, '127.0.0.1');
  apiUrl = await api.getUrl();
  web = await startWeb(webPort, apiUrl);
  // A second web server pointed at a port nothing listens on, for the API-outage cases.
  const deadApiPort = await freePort();
  deadWeb = await startWeb(await freePort(), `http://127.0.0.1:${deadApiPort}`);
});

afterAll(async () => {
  await stopWeb(web);
  await stopWeb(deadWeb);
  await api?.close();
  if (db) await closeDatabase(db);
});

beforeEach(async () => {
  await resetRateLimitState(integrationEnv.TEST_REDIS_URL);
  ids = [];
  apiLog.length = 0;
  // The API's structured security log goes to stderr in-process; capture it to assert nothing sensitive
  // is ever written, without hiding it from the developer.
  consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
    apiLog.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  consoleError.mockRestore();
  await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
  await clearOrphanSecurityEvents(db);
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE' } = {}) {
  const address = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email: address,
      normalizedEmail: address,
      displayName: 'Synthetic Identity',
      status,
    },
  });
  ids.push(user.id);
  await db.passwordCredential.create({
    data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) },
  });
  return user;
}

/** A minimal cookie jar: applies `Set-Cookie` the way a browser would for the attributes in play. */
class Jar {
  cookies = new Map();
  lines = [];
  store(response) {
    for (const line of response.headers.getSetCookie()) {
      this.lines.push(line);
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const maxAge = attributes.find((a) => /^\s*max-age=/i.test(a));
      if (value === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return this.cookies.size === 0
      ? undefined
      : [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function call(
  path,
  { method = 'GET', body, jar, origin = webOrigin, headers = {}, raw, server } = {},
) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) {
    init.body = payload;
    init.headers['content-type'] ??= 'application/json';
  }
  if (origin !== null) init.headers.origin = origin;
  const cookie = jar?.header();
  if (cookie !== undefined) init.headers.cookie = cookie;
  const base = server === 'dead' ? deadWeb.origin : webOrigin;
  const response = await fetch(`${base}${path}`, init);
  jar?.store(response);
  return response;
}
const loginAs = (email, extra = {}) =>
  call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD }, ...extra });
const me = (jar, extra) => call('/api/auth/me', { jar, origin: null, ...extra });
const logout = (jar, extra) => call('/api/auth/logout', { method: 'POST', jar, ...extra });
const sessionsOf = (userId) => db.session.findMany({ where: { userId } });

describe('the served application', () => {
  it('serves the page with framing and sniffing protection and no authenticated content', async () => {
    const response = await call('/', { origin: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-powered-by')).toBeNull();
    const html = await response.text();
    expect(html).toContain('Checking your session');
    expect(html).not.toMatch(/Signed in as|Sign out|Welcome/);
  });
});

describe('login through the proxy', () => {
  it('signs in, sets one HttpOnly session cookie on the web origin, and exposes no token', async () => {
    const user = await account();
    const jar = new Jar();
    const response = await loginAs(user.email, { jar });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      user: { id: user.id, email: user.email, displayName: 'Synthetic Identity' },
    });

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const [line] = cookies;
    expect(line).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\//i);
    expect(line).not.toMatch(/Domain=/i);

    // The token is only in the cookie, never in a body or a readable header, and only its digest is stored.
    const token = line.slice(COOKIE.length + 1).split(';')[0];
    expect(body).not.toContain(token);
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') expect(value, name).not.toContain(token);
    }
    const [row] = await sessionsOf(user.id);
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('answers an unknown address and a wrong password identically, with no cookie', async () => {
    const user = await account();
    const unknown = await call('/api/auth/login', {
      method: 'POST',
      body: { email: `${randomUUID()}@example.test`, password: PASSWORD },
    });
    const wrong = await call('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'entirely different secret phrase' },
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.text()).toBe(await wrong.text());
    expect(unknown.headers.getSetCookie()).toEqual([]);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it('refuses a disabled account with the same generic answer', async () => {
    const user = await account({ status: 'DISABLED' });
    const response = await loginAs(user.email);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ statusCode: 401, error: 'authentication_failed' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('relays the API rate limit as 429 with Retry-After and the generic body', async () => {
    const email = `${randomUUID()}@example.test`;
    let limited;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const response = await call('/api/auth/login', {
        method: 'POST',
        body: { email, password: PASSWORD },
      });
      if (response.status === 429) limited = response;
    }
    expect(limited).toBeDefined();
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await limited.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    expect(limited.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Origin enforcement and CSRF through the proxy', () => {
  it('refuses a login from an untrusted Origin and creates no session', async () => {
    const user = await account();
    const response = await loginAs(user.email, { origin: EVIL });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it('refuses a login with no Origin at all', async () => {
    const user = await account();
    const response = await loginAs(user.email, { origin: null });
    expect(response.status).toBe(403);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it('refuses a cross-site form-encoded login post', async () => {
    const user = await account();
    const response = await call('/api/auth/login', {
      method: 'POST',
      origin: EVIL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      raw: `email=${encodeURIComponent(user.email)}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(response.status).toBe(403);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it('does not let forwarded-host headers launder an untrusted Origin', async () => {
    const user = await account();
    const response = await loginAs(user.email, {
      origin: EVIL,
      headers: {
        'x-forwarded-host': new URL(webOrigin).host,
        'x-forwarded-proto': 'http',
        forwarded: `host=${new URL(webOrigin).host}`,
        referer: `${webOrigin}/`,
      },
    });
    expect(response.status).toBe(403);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  it('refuses a cross-site logout, leaving the session live', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const forged = await logout(jar, { origin: EVIL });
    expect(forged.status).toBe(403);
    const missing = await logout(jar, { origin: null });
    expect(missing.status).toBe(403);
    expect((await me(jar)).status).toBe(200);
    const [row] = await sessionsOf(user.id);
    expect(row.revokedAt).toBeNull();
  });

  it('sends no CORS headers, including on a preflight from another origin', async () => {
    const user = await account();
    const responses = [
      await loginAs(user.email, { origin: EVIL }),
      await call('/api/auth/me', { origin: EVIL }),
      await call('/api/auth/login', {
        method: 'OPTIONS',
        origin: EVIL,
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    ];
    for (const response of responses) {
      for (const [name] of response.headers) expect(name).not.toMatch(/^access-control-/);
    }
  });
});

describe('session restoration, expiry, and logout through the proxy', () => {
  it('restores the identity from the cookie alone', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const response = await me(jar);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).user.id).toBe(user.id);
  });

  it('reports unauthenticated for no cookie, a garbage cookie, and a duplicated cookie', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const token = jar.cookies.get(COOKIE);
    const generic = { statusCode: 401, error: 'authentication_failed' };
    for (const headers of [
      {},
      { cookie: `${COOKIE}=not-a-real-token` },
      { cookie: `${COOKIE}=${token}; ${COOKIE}=${token}` },
    ]) {
      const response = await call('/api/auth/me', { origin: null, headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(generic);
    }
  });

  it('ignores a cookie that is not the session cookie', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const token = jar.cookies.get(COOKIE);
    const response = await call('/api/auth/me', {
      origin: null,
      headers: { cookie: `other=${token}` },
    });
    expect(response.status).toBe(401);
  });

  it('reports an expired session as unauthenticated', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect((await me(jar)).status).toBe(401);
  });

  it('reports a session whose user has been disabled as unauthenticated', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    expect((await me(jar)).status).toBe(200);
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    expect((await me(jar)).status).toBe(401);
  });

  it('logs out: 204, clears the cookie, revokes the session server-side, and the old token is dead', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const token = jar.cookies.get(COOKIE);
    const response = await logout(jar);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()[0]).toMatch(new RegExp(`^${COOKIE}=;.*Max-Age=0`, 'i'));
    expect(jar.cookies.has(COOKIE)).toBe(false);
    const [row] = await sessionsOf(user.id);
    expect(row.revokedAt).not.toBeNull();
    // Replaying the revoked token directly still fails: the revocation is server-side, not cookie deletion.
    const replay = await call('/api/auth/me', {
      origin: null,
      headers: { cookie: `${COOKIE}=${token}` },
    });
    expect(replay.status).toBe(401);
  });

  it('revokes only the presented session', async () => {
    const user = await account();
    const first = new Jar();
    const second = new Jar();
    await loginAs(user.email, { jar: first });
    await loginAs(user.email, { jar: second });
    await logout(first);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });
});

describe('request limits through the real server', () => {
  const post = (body, extra = {}) =>
    fetch(`${webOrigin}/api/auth/login`, {
      method: 'POST',
      // Each of these abandons or rejects a body mid-stream, after which Node will not serve another request
      // on the same keep-alive socket until it is closed. A dedicated connection keeps the cases independent;
      // the last test proves the server itself stays responsive on a fresh one.
      headers: { 'content-type': 'application/json', origin: webOrigin, connection: 'close' },
      body,
      duplex: 'half',
      ...extra,
    });

  it('refuses a chunked body over 4 KiB without reaching the API', async () => {
    const before = apiLog.length;
    const chunks = Array.from({ length: 40 }, () => new Uint8Array(512).fill(0x61));
    const stream = new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const response = await post(stream);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ statusCode: 413, error: 'request_too_large' });
    expect(apiLog.length).toBe(before);
  });

  it('refuses a multibyte body that is under 4096 characters but over 4096 bytes', async () => {
    const body = JSON.stringify({ email: 'a@example.test', password: 'é'.repeat(2100) });
    expect(body.length).toBeLessThan(4096);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4096);
    expect((await post(body)).status).toBe(413);
  });

  it('answers malformed UTF-8 with a generic 400', async () => {
    const response = await post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'invalid_request' });
  });

  it('keeps serving new connections after refusing oversized bodies', async () => {
    const started = Date.now();
    const response = await fetch(`${webOrigin}/api/auth/me`, { headers: { connection: 'close' } });
    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('API outage', () => {
  it('answers a generic 503 that names nothing, so the client treats it as unknown not signed out', async () => {
    const response = await call('/api/auth/me', { origin: null, server: 'dead' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ statusCode: 503, error: 'service_unavailable' });
    expect(body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|fetch failed/);
  });

  it('fails login and logout the same way', async () => {
    for (const path of ['/api/auth/login', '/api/auth/logout']) {
      const response = await call(path, {
        method: 'POST',
        server: 'dead',
        body: path.endsWith('login') ? { email: 'a@example.test', password: 'x' } : undefined,
      });
      expect(response.status).toBe(503);
    }
  });
});

describe('what is logged', () => {
  it('never writes a password, token, or email to the web or API logs', async () => {
    const user = await account();
    const jar = new Jar();
    await loginAs(user.email, { jar });
    const token = jar.cookies.get(COOKIE);
    await call('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'entirely different secret phrase' },
    });
    await me(jar);
    await logout(jar);
    await loginAs(user.email, { origin: EVIL });
    const logs = `${web.output}\n${deadWeb.output}\n${apiLog.join('\n')}`;
    for (const secret of [PASSWORD, 'entirely different secret phrase', token, user.email]) {
      expect(logs).not.toContain(secret);
    }
  });
});
