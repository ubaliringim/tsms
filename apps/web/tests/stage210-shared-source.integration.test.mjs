import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../../api/dist/application.js';
import { hashPassword } from '../../api/dist/identity/password-hasher.js';
import { resetRateLimitState } from '../../api/tests/support/rate-limit-state.mjs';
import { rateLimitKeys } from '../../api/tests/support/stage210-redis.mjs';

/**
 * Stage 2.10.1 RL-06 / WEB-06: what the API sees of the people behind the web proxy.
 *
 *   HTTP client -> real `next start` (production build, same-origin proxy) -> real Nest API -> PostgreSQL + Redis
 *
 * Owner decision D3: production deployment remains BLOCKED on F-05, and no proxy-trust mechanism is selected or
 * implemented until the real ingress and TLS topology is established. This file therefore CHARACTERIZES today's
 * behaviour and asserts the one property that holds. The CHARACTERIZATION tests describe a deployment blocker. They pass
 * because the blocker exists. A passing test here is NOT evidence that the arrangement is safe, and the day a
 * proxy-trust model is implemented they are expected to fail and be replaced.
 *
 * The browser is simulated by a Node `fetch`; what is asserted is the server-observable contract.
 */

const PASSWORD = 'correct horse battery staple';
const integrationEnv = parseIntegrationEnvironment(process.env);
const webRoot = resolve(import.meta.dirname, '..');
const nextBin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');

let db, api, apiUrl, web, webOrigin, ids;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

async function startWeb(port, apiOrigin) {
  const record = { output: '', child: null };
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

beforeAll(async () => {
  const databaseUrl = assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  const webPort = await freePort();
  webOrigin = `http://127.0.0.1:${webPort}`;
  api = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: integrationEnv.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [webOrigin],
    API_RATE_LIMIT_HMAC_SECRET: 'stage210_web_shared_source_rate_limit_key_0123456789',
  });
  await api.listen(0, '127.0.0.1');
  apiUrl = await api.getUrl();
  web = await startWeb(webPort, apiUrl);
}, 180_000);

afterAll(async () => {
  if (web && web.child.exitCode === null) {
    web.child.kill();
    await once(web.child, 'exit').catch(() => undefined);
  }
  await api?.close();
  if (db) await closeDatabase(db);
});

beforeEach(async () => {
  await resetRateLimitState(integrationEnv.TEST_REDIS_URL);
  ids = [];
});

afterEach(async () => {
  // Only this file's own fixture users, and the events attributed to them. This suite never submits an address that
  // matches no account, so it creates no unattributed event and has none to remove.
  await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account() {
  const address = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email: address, normalizedEmail: address, displayName: 'Synthetic Identity' },
  });
  ids.push(user.id);
  await db.passwordCredential.create({
    data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) },
  });
  return user;
}

/** A request as one distinct "browser": its own claimed address, the way a real client behind a real proxy would. */
function asBrowser(claimedAddress, path, { method = 'GET', body } = {}) {
  const headers = {
    origin: webOrigin,
    'x-forwarded-for': claimedAddress,
    'x-real-ip': claimedAddress,
    forwarded: `for=${claimedAddress}`,
    'user-agent': `browser-at-${claimedAddress}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${webOrigin}${path}`, {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const loginAs = (address, email, password = PASSWORD) =>
  asBrowser(address, '/api/auth/login', { method: 'POST', body: { email, password } });

const events = (userId, eventType) =>
  db.authenticationEvent.count({ where: { userId, ...(eventType ? { eventType } : {}) } });

describe('RL-06 / WEB-06 the API sees one client behind the web proxy (F-05, production blocker)', () => {
  it('INVARIANT: through the proxy, client-supplied forwarding headers cannot choose or evade a bucket', async () => {
    // Ten requests, each claiming a different client address in every header a proxy-aware service might trust. Two
    // layers stop them mattering: the proxy does not forward them (unit-tested in auth-proxy.test.ts), and the API would
    // ignore them if it received them (the next test). Either layer alone yields the single bucket asserted here, so this
    // test cannot tell which one held; the next test isolates the API.
    for (let index = 1; index <= 10; index += 1) {
      const response = await asBrowser(`203.0.113.${index}`, '/api/auth/me');
      expect(response.status).toBe(401);
    }
    const buckets = await rateLimitKeys(integrationEnv.TEST_REDIS_URL, 'me:source:');
    expect(buckets).toHaveLength(1);
  });

  it('INVARIANT: sent straight to the API, forwarding headers are ignored too - the bucket is the transport peer', async () => {
    // Bypasses the proxy, so only the API's own client-identity rule is under test. Ten different claimed addresses
    // still produce one source bucket. If the API trusted any of these headers there would be ten.
    for (let index = 1; index <= 10; index += 1) {
      const claimed = `198.51.100.${index}`;
      const response = await fetch(`${apiUrl}/auth/me`, {
        headers: {
          'x-forwarded-for': claimed,
          'x-real-ip': claimed,
          forwarded: `for=${claimed}`,
          'cf-connecting-ip': claimed,
          'true-client-ip': claimed,
        },
      });
      expect(response.status).toBe(401);
    }
    expect(await rateLimitKeys(integrationEnv.TEST_REDIS_URL, 'me:source:')).toHaveLength(1);
  });

  it('CHARACTERIZATION (F-05): every browser behind the proxy spends one shared login-failure bucket', async () => {
    const users = [await account(), await account()];
    for (const [index, user] of users.entries()) {
      const response = await loginAs(
        `198.51.100.${index + 1}`,
        user.email,
        'entirely different secret phrase',
      );
      expect(response.status).toBe(401);
    }
    // Two failures from two "different clients" landed in one source bucket (plus one bucket per targeted account).
    expect(await rateLimitKeys(integrationEnv.TEST_REDIS_URL, 'login:source:')).toHaveLength(1);
    expect(await rateLimitKeys(integrationEnv.TEST_REDIS_URL, 'login:target:')).toHaveLength(2);
  });

  it("CHARACTERIZATION (F-05): one anonymous client's failed logins lock every other user out of signing in", async () => {
    // The login source allowance is ten failures per five minutes. Behind the proxy that allowance belongs to the whole
    // site. Five accounts, two wrong passwords each (below every per-account limit), from one "attacker":
    const targets = [];
    for (let index = 0; index < 5; index += 1) targets.push(await account());
    for (const user of targets) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          (await loginAs('198.51.100.66', user.email, 'entirely different secret phrase')).status,
        ).toBe(401);
      }
    }

    // A different person, from a different claimed address, with the CORRECT password for an account nobody attacked:
    const bystander = await account();
    const refused = await loginAs('203.0.113.50', bystander.email);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    expect(refused.headers.getSetCookie()).toEqual([]);

    // Nothing was attempted for the refused request.
    expect(await db.session.count({ where: { userId: bystander.id } })).toBe(0);
    expect(await events(bystander.id)).toBe(0);
    expect(await rateLimitKeys(integrationEnv.TEST_REDIS_URL, 'login:source:')).toHaveLength(1);
  }, 90_000);

  it('CHARACTERIZATION (F-05): the session-restore budget is also one budget for the whole site', async () => {
    // `/auth/me` is limited to 120 requests per minute per source. Every page load in every browser calls it, so behind
    // the proxy a burst from anyone starves session restoration for everyone. Two hundred and forty unauthenticated
    // lookups, claiming forty different clients, exhaust the budget:
    const statuses = [];
    for (let batch = 0; batch < 4; batch += 1) {
      const responses = await Promise.all(
        Array.from({ length: 60 }, (_, index) =>
          asBrowser(`203.0.113.${(batch * 60 + index) % 40}`, '/api/auth/me'),
        ),
      );
      statuses.push(...responses.map((response) => response.status));
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(60);
    // A client that never took part is refused too. Five at once, because one token refills every half second and a
    // single probe on a slow machine could otherwise land just after a refill.
    const outsiders = await Promise.all(
      Array.from({ length: 5 }, () => asBrowser('192.0.2.200', '/api/auth/me')),
    );
    const refused = outsiders.filter((response) => response.status === 429);
    expect(refused.length).toBeGreaterThanOrEqual(4);
    expect(refused[0].headers.get('retry-after')).toMatch(/^\d+$/);
  }, 90_000);

  it('INVARIANT: successful sign-ins do not spend the login-failure bucket, so ordinary traffic is not the problem', async () => {
    // Twelve different people sign in correctly through the proxy: more than the ten-failure allowance, all admitted,
    // because a success refunds its source reservation. It is failures, not requests, that exhaust the shared bucket.
    const users = [];
    for (let index = 0; index < 12; index += 1) users.push(await account());
    for (const [index, user] of users.entries()) {
      const response = await loginAs(`203.0.113.${100 + index}`, user.email);
      expect(response.status, `sign-in ${index + 1}`).toBe(200);
    }
  }, 120_000);
});
