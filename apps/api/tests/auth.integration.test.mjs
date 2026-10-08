import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';
import { hashSessionToken } from '../dist/identity/session-token.js';

const TRUSTED_ORIGIN = 'http://127.0.0.1:3000';
const COOKIE = 'tsms_session';
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** A real account with a real Argon2id credential. */
const PASSWORD = 'correct horse battery staple';
/** Policy-valid, so it reaches Argon2 rather than short-circuiting in the policy check. */
const OTHER_PASSWORD = 'entirely different secret phrase';

let db, app, origin, ids, emails;

beforeAll(async () => {
  const env = parseIntegrationEnvironment(process.env);
  const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  app = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: env.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [TRUSTED_ORIGIN],
  });
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  if (db) await closeDatabase(db);
});

beforeEach(() => {
  ids = [];
  emails = [];
});

afterEach(async () => {
  if (!db) return;
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', password = PASSWORD, email } = {}) {
  const address = email ?? `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email: address,
      normalizedEmail: address.toLowerCase(),
      displayName: 'Synthetic Identity',
      status,
    },
  });
  ids.push(user.id);
  emails.push(address.toLowerCase());
  if (password !== null) {
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(password) },
    });
  }
  return user;
}

/** Minimal request helper. Cookie and Origin are set explicitly, never by a jar. */
function call(
  path,
  { method = 'GET', body, cookie, origin: requestOrigin, headers = {}, raw } = {},
) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) {
    init.body = payload;
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
  }
  if (cookie !== undefined) init.headers['cookie'] = cookie;
  if (requestOrigin !== undefined) init.headers['origin'] = requestOrigin;
  return fetch(`${origin}${path}`, init);
}

const login = (email, password = PASSWORD, extra = {}) =>
  call('/auth/login', {
    method: 'POST',
    body: { email, password },
    origin: TRUSTED_ORIGIN,
    ...extra,
  });

const GENERIC_FAILURE = { statusCode: 401, error: 'authentication_failed' };
const tokenFrom = (response) => {
  const header = response.headers.getSetCookie?.() ?? [];
  const session = header.find((value) => value.startsWith(`${COOKIE}=`));
  return session?.slice(COOKIE.length + 1).split(';')[0];
};
/**
 * Count only sessions belonging to this test's own fixture users.
 *
 * A global count would make these assertions depend on the database holding no unrelated rows, so
 * a leftover from another suite or an ad-hoc script would be indistinguishable from an
 * authentication defect.
 */
const sessionCount = () => db.session.count({ where: { userId: { in: ids } } });

const me = (cookie) =>
  call('/auth/me', { cookie: cookie === undefined ? undefined : `${COOKIE}=${cookie}` });
const logout = (cookie) =>
  call('/auth/logout', {
    method: 'POST',
    origin: TRUSTED_ORIGIN,
    cookie: cookie === undefined ? undefined : `${COOKIE}=${cookie}`,
  });

// --- Login -------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('returns 200 with the minimal global profile and no raw token in the body', async () => {
    const user = await account();
    const response = await login(user.email);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['user']);
    expect(Object.keys(body.user).sort()).toEqual(['displayName', 'email', 'id']);
    expect(body.user).toEqual({
      id: user.id,
      email: user.email,
      displayName: 'Synthetic Identity',
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(tokenFrom(response));
    expect(text).not.toContain(hashSessionToken(tokenFrom(response)));
    expect(text).not.toContain('normalizedEmail');
    expect(text).not.toContain('status');
    expect(text).not.toContain(PASSWORD);
  });

  it('establishes a secure HttpOnly cookie bounded by the session expiry', async () => {
    await account();
    const response = await login(emails[0]);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain');
    expect(cookie).not.toContain('__Host-');
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
    expect(maxAge).toBeGreaterThan(LIFETIME_MS / 1000 - 120);
    expect(maxAge).toBeLessThanOrEqual(LIFETIME_MS / 1000);
  });

  it('never places the token in a URL, query, or any header other than the cookie', async () => {
    await account();
    const response = await login(emails[0]);
    const token = tokenFrom(response);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const nonCookie = [...response.headers]
      .filter(([name]) => name.toLowerCase() !== 'set-cookie')
      .map(([, value]) => value)
      .join(' ');
    expect(nonCookie).not.toContain(token);
    expect(response.url).not.toContain(token);
  });

  it('persists only the token digest and never the raw token', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.revokedAt).toBeNull();
  });

  it('normalizes the submitted address for lookup but returns the stored presentation form', async () => {
    const user = await account({ email: 'Person@Example.test' });
    const response = await login('  PERSON@EXAMPLE.TEST  ');
    expect(response.status).toBe(200);
    // normalizedEmail is what the lookup used; the stored `email` is what is returned.
    expect((await response.json()).user.email).toBe('Person@Example.test');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).normalizedEmail).toBe(
      'person@example.test',
    );
  });

  it('does not trim or transform the password', async () => {
    const padded = '  spaces are significant here  ';
    await account({ password: padded });
    const wrong = await login(emails[0], padded.trim());
    expect(wrong.status).toBe(401);
    expect(await login(emails[0], padded).then((r) => r.status)).toBe(200);
  });

  it('creates no session for any invalid login', async () => {
    const user = await account();
    const noCredential = await account({ password: null });
    const disabled = await account({ status: 'DISABLED' });

    expect((await login(user.email, OTHER_PASSWORD)).status).toBe(401);
    expect((await login('nobody@example.test')).status).toBe(401);
    expect((await login(noCredential.email)).status).toBe(401);
    expect((await login(disabled.email)).status).toBe(401);

    expect(await sessionCount()).toBe(0);
  });

  it('answers every authentication failure with one indistinguishable body', async () => {
    const user = await account();
    const noCredential = await account({ password: null });
    const disabled = await account({ status: 'DISABLED' });

    const attempts = [
      login('nobody@example.test'),
      login(user.email, OTHER_PASSWORD),
      login(noCredential.email),
      login(disabled.email),
    ];
    const responses = await Promise.all(attempts);
    const rendered = [];
    for (const response of responses) {
      rendered.push({
        status: response.status,
        body: await response.json(),
        cache: response.headers.get('cache-control'),
        vary: response.headers.get('vary'),
      });
    }
    for (const entry of rendered) expect(entry).toEqual(rendered[0]);
    expect(rendered[0]).toEqual({
      status: 401,
      body: GENERIC_FAILURE,
      cache: 'no-store',
      vary: 'Origin',
    });
    // The fixed body must not hint at which condition occurred.
    const text = JSON.stringify(rendered[0].body).toLowerCase();
    for (const hint of ['user', 'credential', 'password', 'disabled', 'exist', 'not found']) {
      expect(text).not.toContain(hint);
    }
  });

  it.each([
    ['a JSON array', '[]', 'application/json'],
    ['null', 'null', 'application/json'],
    ['a bare string', '"hello"', 'application/json'],
    ['a number', '7', 'application/json'],
    ['malformed JSON', '{"email":', 'application/json'],
    ['malformed JSON mid-token', '{"email":"a@b.test","password":"x" oops}', 'application/json'],
    ['an empty body', '', 'application/json'],
  ])('rejects %s without echoing the submitted value', async (_label, raw) => {
    const response = await call('/auth/login', {
      method: 'POST',
      raw,
      origin: TRUSTED_ORIGIN,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    // The parser's own message quotes the offending fragment, so it must be replaced wholesale.
    expect(JSON.parse(text)).toEqual({ statusCode: 400, error: 'invalid_request' });
    expect(text).not.toContain('JSON');
    expect(text).not.toContain('email');
    expect(text).not.toContain('oops');
  });

  it.each([
    ['a missing password', { email: 'a@example.test' }],
    ['a missing email', { password: PASSWORD }],
    ['an unexpected field', { email: 'a@example.test', password: PASSWORD, role: 'ADMIN' }],
    ['a nested field', { email: 'a@example.test', password: PASSWORD, tenant: { id: '1' } }],
    ['a numeric password', { email: 'a@example.test', password: 12345678901234 }],
    ['a null password', { email: 'a@example.test', password: null }],
    ['an array password', { email: 'a@example.test', password: [PASSWORD] }],
    ['an object password', { email: 'a@example.test', password: { value: PASSWORD } }],
    ['a boolean email', { email: true, password: PASSWORD }],
    ['an empty object', {}],
  ])('rejects %s with the fixed malformed-request body', async (_label, body) => {
    const response = await call('/auth/login', { method: 'POST', body, origin: TRUSTED_ORIGIN });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'invalid_request' });
    expect(await sessionCount()).toBe(0);
  });

  it('requires a JSON content type', async () => {
    const response = await call('/auth/login', {
      method: 'POST',
      raw: `email=a%40example.test&password=${encodeURIComponent(PASSWORD)}`,
      origin: TRUSTED_ORIGIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'invalid_request' });
  });

  it('rejects a body over the size limit without parsing it', async () => {
    const response = await call('/auth/login', {
      method: 'POST',
      origin: TRUSTED_ORIGIN,
      raw: JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(8192) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ statusCode: 413, error: 'request_too_large' });
    expect(await sessionCount()).toBe(0);
  });

  it('does not authenticate when the database is unavailable', async () => {
    await account();
    const unavailable = await createApplication({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      // Loopback port with nothing listening: startup succeeds, the lookup fails.
      DATABASE_URL: 'postgresql://tsms:tsms_test@127.0.0.1:5499/tsms_test',
      REDIS_URL: 'redis://:tsms_test@127.0.0.1:6399/1',
      API_TRUSTED_ORIGINS: [TRUSTED_ORIGIN],
    });
    await unavailable.listen(0, '127.0.0.1');
    const broken = await unavailable.getUrl();
    try {
      const response = await fetch(`${broken}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        body: JSON.stringify({ email: emails[0], password: PASSWORD }),
      });
      // Not a 200, and not a claim that the credentials were wrong.
      expect(response.status).not.toBe(200);
      const text = await response.text();
      expect(text.toLowerCase()).not.toContain('econnrefused');
      expect(text.toLowerCase()).not.toContain('127.0.0.1:5499');
      expect(text).not.toContain(PASSWORD);
    } finally {
      await unavailable.close();
    }
  });
});

// --- Current user ------------------------------------------------------------------

describe('GET /auth/me', () => {
  it('returns the minimal global profile for a valid cookie', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const response = await me(token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(await response.json()).toEqual({
      user: { id: user.id, email: user.email, displayName: 'Synthetic Identity' },
    });
  });

  it('returns no credential, session, tenant, or role information', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    const text = await (await me(token)).text();
    for (const forbidden of [
      'passwordHash',
      'tokenHash',
      'normalizedEmail',
      'sessionId',
      'tenant',
      'school',
      'role',
      'permission',
      'normalizedEmail',
      'emailVerifiedAt',
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(text).not.toContain(row.tokenHash);
    expect(text).not.toContain(row.id);
  });

  it.each([
    ['no cookie', undefined],
    ['an empty cookie', ''],
    ['a non-token cookie', 'not-a-real-session-token'],
    ['a token of the wrong length', 'a'.repeat(42)],
    ['a non-canonical token', `${'a'.repeat(42)}=`],
    ['a well-formed but unknown token', 'A'.repeat(43)],
    ['a duplicated session cookie', '__DUPLICATE__'],
  ])('returns 401 for %s', async (_label, cookie) => {
    await account();
    const header = cookie === '__DUPLICATE__' ? `${COOKIE}=first; ${COOKIE}=second` : cookie;
    const response =
      header === undefined
        ? await me(undefined)
        : await call('/auth/me', { cookie: `${COOKIE}=${header}` });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(GENERIC_FAILURE);
  });

  it('returns 401 for an expired session', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    // Written directly rather than waited on, so the test neither sleeps nor is flaky.
    await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
    const response = await me(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(GENERIC_FAILURE);
  });

  it('returns 401 for a revoked session', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    await db.session.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date('2030-01-01T00:00:00.000Z') },
    });
    expect((await me(token)).status).toBe(401);
  });

  it('returns 401 once the user is disabled, without deleting the session', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    expect((await me(token)).status).toBe(401);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

// --- Logout ------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('revokes the current session, clears the cookie, and returns an empty 204', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const response = await logout(token);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const cleared = response.headers.getSetCookie().find((value) => value.startsWith(`${COOKIE}=`));
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('Max-Age=0');
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.revokedAt).not.toBeNull();
    expect((await me(token)).status).toBe(401);
  });

  it('is safe to repeat and safe without any cookie', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    expect((await logout(token)).status).toBe(204);
    const before = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect((await logout(token)).status).toBe(204);
    expect((await logout(undefined)).status).toBe(204);
    expect((await logout('not-a-real-session-token')).status).toBe(204);
    const after = await db.session.findFirstOrThrow({ where: { id: before.id } });
    // The original revocation timestamp is preserved rather than rewritten.
    expect(after.revokedAt.getTime()).toBe(before.revokedAt.getTime());
    expect(await sessionCount()).toBe(1);
  });

  it('does not reveal whether a presented token ever existed', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    await logout(token);
    const real = await logout(token);
    const fake = await logout('A'.repeat(43));
    expect(real.status).toBe(fake.status);
    expect(await real.text()).toBe(await fake.text());
    const headers = (response) => response.headers.getSetCookie().sort().join('|');
    expect(headers(real)).toBe(headers(fake));
  });

  it('revokes only the presented session, not another session of the same user', async () => {
    const user = await account();
    const first = tokenFrom(await login(user.email));
    const second = tokenFrom(await login(user.email));
    expect(first).not.toBe(second);
    expect((await logout(first)).status).toBe(204);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  it('never revokes another user session', async () => {
    const victim = await account();
    const attacker = await account();
    const victimToken = tokenFrom(await login(victim.email));
    const attackerToken = tokenFrom(await login(attacker.email));
    expect((await logout(attackerToken)).status).toBe(204);
    expect((await me(victimToken)).status).toBe(200);
    const victimRow = await db.session.findFirstOrThrow({ where: { userId: victim.id } });
    expect(victimRow.revokedAt).toBeNull();
  });
});

// --- CSRF, transport, and headers --------------------------------------------------

describe('origin and CSRF enforcement', () => {
  it('accepts a request from an allowed origin', async () => {
    const user = await account();
    expect((await login(user.email)).status).toBe(200);
  });

  it.each([
    ['a different scheme', 'https://127.0.0.1:3000'],
    ['a different port', 'http://127.0.0.1:3001'],
    ['a different host', 'http://localhost:3000'],
    ['a subdomain', 'http://evil.127.0.0.1:3000'],
    ['a suffix lookalike', 'http://127.0.0.1:3000.evil.test'],
    ['a wildcard', '*'],
    ['a trailing slash', 'http://127.0.0.1:3000/'],
    ['an allowlist pair', 'http://127.0.0.1:3000,http://127.0.0.1:3001'],
  ])('rejects login from %s', async (_label, origin) => {
    const user = await account();
    const response = await login(user.email, PASSWORD, { origin });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
    expect(await sessionCount()).toBe(0);
  });

  it('fails closed when Origin is missing on a state-changing route', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const anonymous = await call('/auth/login', {
      method: 'POST',
      body: { email: user.email, password: PASSWORD },
    });
    expect(anonymous.status).toBe(403);
    // Logout must not be forgeable either.
    const forge = await call('/auth/logout', {
      method: 'POST',
      cookie: `${COOKIE}=${token}`,
    });
    expect(forge.status).toBe(403);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
  });

  it.each([
    ['x-forwarded-host', { 'x-forwarded-host': TRUSTED_ORIGIN }],
    ['x-forwarded-proto', { 'x-forwarded-proto': 'https' }],
    ['x-original-host', { 'x-original-host': 'attacker.test' }],
    ['referer', { referer: `${TRUSTED_ORIGIN}/login` }],
    ['forwarded', { forwarded: `host=127.0.0.1:3000;proto=https` }],
  ])('does not let a spoofed %s header authorise a request', async (_label, headers) => {
    const user = await account();
    const response = await call('/auth/login', {
      method: 'POST',
      body: { email: user.email, password: PASSWORD },
      headers,
    });
    expect(response.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it('does not require Origin on the safe current-user route', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    expect((await me(token)).status).toBe(200);
  });
});

describe('response transport security', () => {
  it('marks every authentication response uncacheable', async () => {
    const user = await account();
    const token = tokenFrom(await login(user.email));
    const responses = [
      await login(user.email, OTHER_PASSWORD),
      await me(undefined),
      await me(token),
      await logout(undefined),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Origin');
    }
  });

  it('does not emit credentialed CORS headers', async () => {
    const user = await account();
    const response = await login(user.email);
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-headers',
    ]) {
      expect(response.headers.get(header)).toBeNull();
    }
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});

describe('Stage 2.4 scope regression', () => {
  it('exposes no registration, session-management, or revocation routes', async () => {
    // Stage 2.5 adds /auth/password/forgot and /auth/password/reset, so those are no longer
    // expected to 404 here; password-recovery.integration.test.mjs covers them instead.
    const routes = [
      ['POST', '/auth/register'],
      ['POST', '/auth/signup'],
      ['POST', '/auth/password/change'],
      ['GET', '/auth/sessions'],
      ['POST', '/auth/logout-all'],
      ['POST', '/auth/revoke-all'],
      ['POST', '/auth/school/join'],
      ['GET', '/auth/tenants'],
      ['POST', '/auth/refresh'],
    ];
    for (const [method, path] of routes) {
      const response = await call(path, { method, origin: TRUSTED_ORIGIN });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('still serves the accepted liveness and readiness routes unchanged', async () => {
    const health = await call('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'tsms-api' });
    const ready = await call('/ready');
    expect(ready.status).toBe(200);
    expect((await ready.json()).ready).toBe(true);
  });

  it('writes no authentication events and creates no session for a failed login', async () => {
    const user = await account();
    await login(user.email, OTHER_PASSWORD);
    expect(await db.authenticationEvent.count({ where: { userId: { in: ids } } })).toBe(0);
    expect(await sessionCount()).toBe(0);
  });
});
