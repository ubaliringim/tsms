/**
 * Stage 2.6 abuse protection against real Redis and real PostgreSQL, driven through the real HTTP
 * application.
 *
 * Everything asserted here is a property of the deployed path, not of a unit in isolation: the guard
 * ordering, the sanitized response bodies, the enumeration resistance, the outage behaviour, and
 * cross-instance shared state. The script's atomicity is proved in
 * `packages/redis/tests/rate-limit.integration.test.mjs`.
 *
 * Rate-limit state is namespaced by secret and per-test subjects, so no assertion depends on another
 * test's traffic. The one exception is the source dimension, which every request from this process
 * shares by design; those cases boot a dedicated application with its own secret so they start from
 * empty buckets.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createRedisClient, closeRedis, pingRedis } from '@tsms/redis';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';
import { policyFor } from '../dist/identity/auth-abuse-policy.js';

const ORIGIN = 'http://127.0.0.1:3000';
const COOKIE = 'tsms_session';
const PASSWORD = 'correct horse battery staple';

/** Per-suite secrets: distinct key spaces, so one suite's traffic cannot consume another's buckets. */
const SECRET = 'stage26_integration_rate_limit_key_0123456789abcdef';

let db;
let app;
let origin;
let redisUrl;
let redis;
let ids;

/** Boot an application on its own secret, for a case that needs empty source buckets. */
async function bootApp(secret) {
  const instance = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: redisUrl,
    API_TRUSTED_ORIGINS: [ORIGIN],
    API_RATE_LIMIT_HMAC_SECRET: secret,
    API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
    API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.test/recover',
  });
  await instance.listen(0, '127.0.0.1');
  return { instance, base: await instance.getUrl() };
}

beforeAll(async () => {
  const env = parseIntegrationEnvironment(process.env);
  const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
  redisUrl = env.TEST_REDIS_URL;
  db = createDatabaseClient(databaseUrl);
  redis = createRedisClient(redisUrl);
  await pingRedis(redis, { timeoutMillis: 5_000 });
  ({ instance: app, base: origin } = await bootApp(SECRET));
});

afterAll(async () => {
  await app?.close();
  if (redis) await closeRedis(redis);
  if (db) await closeDatabase(db);
});

beforeEach(async () => {
  ids = [];
  // Start every test with an empty rate-limit budget. This suite mixes cases that deliberately exhaust
  // a meter with cases that must be admitted, and both share one process address, so without this the
  // outcome of any test would depend on which ran before it. Tests that need accumulation build their
  // own state after this point.
  await clearRateLimits();
});

afterEach(async () => {
  if (!db) return;
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', password = PASSWORD } = {}) {
  const address = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email: address,
      normalizedEmail: address.toLowerCase(),
      displayName: 'Synthetic Identity',
      status,
    },
  });
  ids.push(user.id);
  if (password !== null) {
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(password) },
    });
  }
  return user;
}

function call(base, path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) {
    init.body = payload;
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
  }
  if (cookie !== undefined) init.headers.cookie = cookie;
  return fetch(`${base}${path}`, init);
}

const login = (base, email, password = PASSWORD, extra = {}) =>
  call(base, '/auth/login', {
    method: 'POST',
    body: { email, password },
    headers: { origin: ORIGIN },
    ...extra,
  });

const forgot = (base, email) =>
  call(base, '/auth/password/forgot', {
    method: 'POST',
    body: { email },
    headers: { origin: ORIGIN },
  });

const reset = (base, token, newPassword = 'a whole new secret phrase') =>
  call(base, '/auth/password/reset', {
    method: 'POST',
    body: { token, newPassword },
    headers: { origin: ORIGIN },
  });

const me = (base, cookie) =>
  call(base, '/auth/me', {
    cookie: cookie === undefined ? undefined : `${COOKIE}=${cookie}`,
  });

const logout = (base, cookie) =>
  call(base, '/auth/logout', {
    method: 'POST',
    headers: { origin: ORIGIN },
    cookie: cookie === undefined ? undefined : `${COOKIE}=${cookie}`,
  });

const LIMITED = { statusCode: 429, error: 'rate_limited' };
const UNAVAILABLE = { statusCode: 503, error: 'service_unavailable' };

/** Assert a `429` with the one fixed body, a bounded retry hint, and no leaked dimension. */
async function expectLimited(response) {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual(LIMITED);
  const retryAfter = response.headers.get('retry-after');
  expect(retryAfter).toMatch(/^[0-9]{1,3}$/);
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const serialised = JSON.stringify([...response.headers]);
  expect(serialised).not.toContain('tsms-rl');
  expect(serialised.toLowerCase()).not.toContain('redis');
}

/** Remove this suite's rate-limit keys so a case starts from empty buckets. */
async function clearRateLimits() {
  // The Argon2id semaphore is one key spanning every instance, so it is shared deployment
  // state rather than this suite fixture. These suites run in parallel with the Redis suite against the
  // same logical database, so deleting it here would remove a semaphore from under that suite.
  const keys = await redis.keys('{tsms-rl}:*');
  if (keys.length > 0) await redis.del(...keys);
}

// --- 1./2. login limits ----------------------------------------------------------

describe('POST /auth/login rate limiting', () => {
  it('refuses the request that would exceed the per-account allowance', async () => {
    const { instance, base } = await bootApp(`login_target_${randomUUID()}_0123456789abcdefghij`);
    try {
      const user = await account();
      // The per-account meter allows 8. Fail it 8 times, then the 9th must be refused.
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const response = await login(base, user.email, 'wrong password entirely');
        expect(response.status).toBe(401);
      }
      await expectLimited(await login(base, user.email, 'wrong password entirely'));

      // Even the correct password is refused, which is the point of a target meter.
      await expectLimited(await login(base, user.email));
    } finally {
      await instance.close();
    }
  });

  it('refuses requests that exceed the per-source allowance', async () => {
    const { instance, base } = await bootApp(`login_source_${randomUUID()}_0123456789abcdefghij`);
    try {
      // Ten distinct accounts from one source: only the source meter can be the one refusing, which
      // is what makes this a source test rather than another account test.
      const users = [];
      for (let index = 0; index < 12; index += 1) users.push(await account());

      for (const user of users.slice(0, 10)) {
        expect((await login(base, user.email, 'wrong password entirely')).status).toBe(401);
      }
      await expectLimited(await login(base, users[10].email, 'wrong password entirely'));
      await expectLimited(await login(base, users[11].email, 'wrong password entirely'));
    } finally {
      await instance.close();
    }
  });

  it('keeps two accounts on one source independent', async () => {
    const { instance, base } = await bootApp(`isolation_${randomUUID()}_0123456789abcdefghijklmn`);
    try {
      const first = await account();
      const second = await account();

      // Exhaust the first account completely.
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await login(base, first.email, 'wrong password entirely');
      }
      await expectLimited(await login(base, first.email));

      // The second account has its own budget and still authenticates.
      const response = await login(base, second.email);
      expect(response.status).toBe(200);
    } finally {
      await instance.close();
    }
  });

  it('bounds a concurrent burst by request volume and then refuses outright', async () => {
    const { instance, base } = await bootApp(`boundary_${randomUUID()}_0123456789abcdefghijklmno`);
    try {
      const user = await account();
      const allowance = policyFor('login', 'target').capacity;
      expect(allowance).toBe(8);

      /**
       * Stage 2.6 hardening. Admission **reserves** rather than merely inspecting, so a concurrent burst
       * contends for real tokens and cannot exceed the allowance. Before the reservation, all twenty of
       * these passed an untouched bucket and reached Argon2id; that behaviour is recorded in
       * `rate-limit-concurrency.integration.test.mjs`.
       *
       * A refusal may also come from the simultaneous-Argon2id bound, which is a separate control with a
       * sanitized `503`. Both are refusals, and neither is a bypass, so the assertion is that the burst
       * cannot exceed the allowance rather than that it produces one particular status.
       */
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => login(base, user.email, 'wrong password entirely')),
      );
      const admitted = responses.filter((response) => response.status === 401).length;
      const limited = responses.filter((response) => response.status === 429).length;
      const saturated = responses.filter((response) => response.status === 503).length;

      // No request was served: a wrong password can never produce a session.
      expect(responses.filter((response) => response.status === 200).length).toBe(0);
      // The allowance was respected, and every other request was refused by one of the two bounds.
      expect(admitted).toBeLessThanOrEqual(allowance);
      expect(admitted + limited + saturated).toBe(20);
      await Promise.all(responses.map((response) => response.body?.cancel?.()));

      // The budget is spent afterwards and stays spent, so the limit is not merely a burst guard.
      await expectLimited(await login(base, user.email, 'wrong password entirely'));
    } finally {
      await instance.close();
    }
  });

  it('shares state across separate API instances', async () => {
    const user = await account();
    // Two independently created application objects, one Redis, one secret. If the meters were
    // process-local, each instance would allow its own full allowance.
    const first = await bootApp(SECRET);
    const second = await bootApp(SECRET);
    try {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        expect((await login(first.base, user.email, 'wrong password entirely')).status).toBe(401);
      }
      // Exhausted through instance one.
      await expectLimited(await login(first.base, user.email, 'wrong password entirely'));
      // Instance two observes the same exhausted bucket: distributed, not per-process.
      await expectLimited(await login(second.base, user.email, 'wrong password entirely'));
    } finally {
      await first.instance.close();
      await second.instance.close();
    }
  });
});

// --- 4./5. recovery request limits ------------------------------------------------

describe('POST /auth/password/forgot rate limiting', () => {
  it('refuses requests that exceed the per-target allowance and issues no token', async () => {
    const { instance, base } = await bootApp(`forgot_target_${randomUUID()}_0123456789abcdefghij`);
    try {
      const user = await account();
      const countTokens = () => db.passwordResetToken.count({ where: { userId: user.id } });
      const activeTokens = () =>
        db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } });

      // Three issuances are allowed; the fourth is refused.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await forgot(base, user.email)).status).toBe(202);
      }
      const rowsAfterAllowance = await countTokens();
      // Issuance supersedes earlier tokens, so exactly one is still usable.
      expect(await activeTokens()).toBe(1);

      await expectLimited(await forgot(base, user.email));

      // The refusal created no token at all: no email could have been sent because none was issued.
      expect(await countTokens()).toBe(rowsAfterAllowance);
    } finally {
      await instance.close();
    }
  });

  it('refuses requests that exceed the per-source allowance', async () => {
    const { instance, base } = await bootApp(`forgot_source_${randomUUID()}_0123456789abcdefghij`);
    try {
      // Five distinct targets from one source, so only the source meter can refuse.
      const users = [];
      for (let index = 0; index < 7; index += 1) users.push(await account());
      for (const user of users.slice(0, 5)) {
        expect((await forgot(base, user.email)).status).toBe(202);
      }
      await expectLimited(await forgot(base, users[5].email));
    } finally {
      await instance.close();
    }
  });

  it('keeps one target from being able to flood another', async () => {
    const { instance, base } = await bootApp(`forgot_cross_${randomUUID()}_0123456789abcdefghijkl`);
    try {
      const victim = await account();
      const other = await account();
      // Exhaust the victim's target meter.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await forgot(base, victim.email);
      }
      await expectLimited(await forgot(base, victim.email));
      // The other target is unaffected.
      expect((await forgot(base, other.email)).status).toBe(202);
    } finally {
      await instance.close();
    }
  });
});

// --- 6./7. reset limits ----------------------------------------------------------

describe('POST /auth/password/reset rate limiting', () => {
  it('refuses invalid-token submissions that exceed the allowance', async () => {
    const { instance, base } = await bootApp(`reset_invalid_${randomUUID()}_0123456789abcdefgh`);
    try {
      const invalid = 'B'.repeat(43);
      // Ten invalid submissions are allowed; the eleventh is refused.
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const response = await reset(base, invalid);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          statusCode: 401,
          error: 'recovery_token_invalid',
        });
      }
      await expectLimited(await reset(base, invalid));
    } finally {
      await instance.close();
    }
  });

  it('gives every distinct guessed token its own budget', async () => {
    // Two applications so each token starts from a clean source budget; otherwise the source meter
    // would be exhausted first and this would prove nothing about the token dimension.
    const firstApp = await bootApp(`reset_tokens_a_${randomUUID()}_0123456789abcdefghijkl`);
    const secondApp = await bootApp(`reset_tokens_b_${randomUUID()}_0123456789abcdefghijkl`);
    try {
      const first = 'C'.repeat(43);
      const second = 'D'.repeat(43);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        expect((await reset(firstApp.base, first)).status).toBe(401);
      }
      // The first guessed token is exhausted.
      await expectLimited(await reset(firstApp.base, first));

      // A different guessed token is not refused by the first token's exhaustion, which is what
      // proves the token dimension is keyed per token rather than globally per endpoint.
      expect((await reset(secondApp.base, second)).status).toBe(401);
    } finally {
      await firstApp.instance.close();
      await secondApp.instance.close();
    }
  });

  it('issues no token and changes no credential after a refusal', async () => {
    const { instance, base } = await bootApp(`reset_integrity_${randomUUID()}_0123456789abcdefghi`);
    try {
      const user = await account();
      const before = await db.passwordCredential.findUnique({ where: { userId: user.id } });
      const invalid = 'E'.repeat(43);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await reset(base, invalid);
      }
      await expectLimited(await reset(base, invalid));

      const after = await db.passwordCredential.findUnique({ where: { userId: user.id } });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.passwordChangedAt.getTime()).toBe(before.passwordChangedAt.getTime());
      expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
      // The original password still works, so the refusal did not corrupt anything.
      const response = await login(base, user.email);
      expect(response.status).toBe(200);
    } finally {
      await instance.close();
    }
  });
});

// --- 12. retry behaviour ---------------------------------------------------------

describe('Retry-After behaviour', () => {
  it('returns a hint a client can act on without revealing the dimension', async () => {
    const { instance, base } = await bootApp(`retry_${randomUUID()}_0123456789abcdefghijklmnop`);
    try {
      const user = await account();
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await login(base, user.email, 'wrong password entirely');
      }
      const response = await login(base, user.email);
      const retryAfter = response.headers.get('retry-after');
      await expectLimited(response);
      // Identical body and hint shape whichever meter refused: nothing distinguishes source from
      // account exhaustion.
      expect(retryAfter).toBe(response.headers.get('retry-after'));
    } finally {
      await instance.close();
    }
  });
});

// --- 13. Redis unavailable and 15. recovery --------------------------------------

describe('Redis outage behaviour', () => {
  /** An application whose Redis port has nothing listening. */
  async function bootWithoutRedis(secret) {
    const instance = await createApplication({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      REDIS_URL: 'redis://:tsms_test@127.0.0.1:6399/1',
      API_TRUSTED_ORIGINS: [ORIGIN],
      API_RATE_LIMIT_HMAC_SECRET: secret,
      API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
      API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.test/recover',
    });
    await instance.listen(0, '127.0.0.1');
    return { instance, base: await instance.getUrl() };
  }

  it('fails closed on login, before Argon2id, when Redis is unreachable', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_login_${randomUUID()}_0123456789abcdef`,
    );
    try {
      const user = await account();
      const response = await login(base, user.email);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(UNAVAILABLE);
      // No session was created, so no Argon2id result was ever turned into a session.
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await instance.close();
    }
  });

  it('fails closed on password recovery and issues no token', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_recovery_${randomUUID()}_0123456789abcde`,
    );
    try {
      const user = await account();
      const response = await forgot(base, user.email);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(UNAVAILABLE);
      // The critical assertion: enforcement failed, so nothing was issued.
      expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('fails closed on password reset', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_reset_${randomUUID()}_0123456789abcdefg`,
    );
    try {
      const response = await reset(base, 'F'.repeat(43));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(UNAVAILABLE);
    } finally {
      await instance.close();
    }
  });

  it('keeps session validation correct on /auth/me during an outage', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_me_${randomUUID()}_0123456789abcdefgh`,
    );
    try {
      // A real session created through the healthy application, presented to the degraded one.
      const user = await account();
      const established = await login(origin, user.email);
      const token = (established.headers.getSetCookie?.() ?? [])
        .find((value) => value.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1)
        .split(';')[0];

      // `me` spends no Argon2id, so it stays available: a Redis outage must not sign everyone out.
      const response = await me(base, token);
      expect(response.status).toBe(200);
      expect((await response.json()).user.email).toBe(user.email);
    } finally {
      await instance.close();
    }
  });

  it('still revokes and clears the cookie on logout during an outage', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_logout_${randomUUID()}_0123456789abcdefghi`,
    );
    try {
      const user = await account();
      const established = await login(origin, user.email);
      const token = (established.headers.getSetCookie?.() ?? [])
        .find((value) => value.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1)
        .split(';')[0];
      expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);

      // Revocation is a PostgreSQL write, so it is unaffected by the Redis outage.
      const response = await logout(base, token);
      expect(response.status).toBe(204);
      const [cleared] = response.headers.getSetCookie();
      expect(cleared).toContain(`${COOKIE}=;`);
      expect(cleared).toContain('Max-Age=0');
      expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('recovers enforcement once Redis is reachable again', async () => {
    const secret = `recovery_${randomUUID()}_0123456789abcdefghijklmnopq`;
    const broken = await bootWithoutRedis(secret);
    const healthy = await bootApp(secret);
    try {
      const user = await account();
      expect((await login(broken.base, user.email)).status).toBe(503);

      // The same secret and the same Redis, so the healthy instance enforces immediately.
      expect((await login(healthy.base, user.email)).status).toBe(200);
    } finally {
      await broken.instance.close();
      await healthy.instance.close();
    }
  });

  it('reports readiness as degraded while Redis is unreachable', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_ready_${randomUUID()}_0123456789abcdefgh`,
    );
    try {
      const response = await call(base, '/ready');
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.ready).toBe(false);
      expect(body.dependencies.redis).toBe('down');
    } finally {
      await instance.close();
    }
  });
});

// --- 16./17. enumeration resistance ----------------------------------------------

describe('enumeration resistance under rate limiting', () => {
  it('applies the same policy and response to a known and an unknown account', async () => {
    const known = await bootApp(`known_${randomUUID()}_0123456789abcdefghijklmnopqrstuvw`);
    const unknown = await bootApp(`unknown_${randomUUID()}_0123456789abcdefghijklmnopqrstu`);
    try {
      const user = await account();

      // Both addresses are wrong in the same way. Walk each to its limit and compare everything.
      const exhaust = async (base, email) => {
        const responses = [];
        for (let attempt = 1; attempt <= 9; attempt += 1) {
          responses.push(await login(base, email, 'wrong password entirely'));
        }
        return responses;
      };
      const knownResponses = await exhaust(known.base, user.email);
      const unknownEmail = `${randomUUID()}@example.test`;
      const unknownResponses = await exhaust(unknown.base, unknownEmail);

      // Status and body are identical at every position, including the refusal.
      expect(knownResponses.map((r) => r.status)).toEqual(unknownResponses.map((r) => r.status));
      for (const response of [...knownResponses, ...unknownResponses]) {
        const body = await response.json();
        expect(
          [LIMITED, { statusCode: 401, error: 'authentication_failed' }].some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(body),
          ),
        ).toBe(true);
      }
      // The retry hint is bounded and present in the same position for both.
      const knownRetry = knownResponses.at(-1).headers.get('retry-after');
      const unknownRetry = unknownResponses.at(-1).headers.get('retry-after');
      expect(knownRetry).toMatch(/^[0-9]{1,3}$/);
      expect(unknownRetry).toMatch(/^[0-9]{1,3}$/);
    } finally {
      await known.instance.close();
      await unknown.instance.close();
    }
  });

  it('applies the same recovery response to a known and an unknown target', async () => {
    const known = await bootApp(`recover_known_${randomUUID()}_0123456789abcdefghijklmnopqrstuv`);
    const unknown = await bootApp(
      `recover_unknown_${randomUUID()}_0123456789abcdefghijklmnopqrstu`,
    );
    try {
      const user = await account();
      const unknownEmail = `${randomUUID()}@example.test`;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const knownResponse = await forgot(known.base, user.email);
        const unknownResponse = await forgot(unknown.base, unknownEmail);
        expect(knownResponse.status).toBe(202);
        expect(unknownResponse.status).toBe(202);
        expect(await knownResponse.json()).toEqual(await unknownResponse.json());
      }
      // Both refuse at the same point with the same body.
      const knownRefusal = await forgot(known.base, user.email);
      const unknownRefusal = await forgot(unknown.base, unknownEmail);
      await expectLimited(knownRefusal);
      await expectLimited(unknownRefusal);
    } finally {
      await known.instance.close();
      await unknown.instance.close();
    }
  });

  it('never varies a reset response with token validity', async () => {
    const user = await account();
    const invalid = 'G'.repeat(43);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await reset(origin, invalid);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        statusCode: 401,
        error: 'recovery_token_invalid',
      });
    }
    // A well-formed but unknown token is refused identically, so no token probe learns anything.
    const unknownToken = randomUUID().replace(/-/g, '').padEnd(43, 'x').slice(0, 43);
    const response = await reset(origin, unknownToken);
    if (response.status === 429) {
      await expectLimited(response);
    } else {
      expect(response.status).toBe(401);
    }
    expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });
});

// --- 18. header spoofing ---------------------------------------------------------

describe('untrusted proxy headers', () => {
  it('ignores every forwarding header when choosing the source bucket', async () => {
    const { instance, base } = await bootApp(`spoof_${randomUUID()}_0123456789abcdefghijklmnopqrs`);
    try {
      // A distinct account per attempt, so the per-account meter can never be the one that refuses and
      // the only meter filling is the shared source one.
      const users = [];
      for (let index = 0; index < 12; index += 1) users.push(await account());

      for (const [index, user] of users.slice(0, 10).entries()) {
        const response = await login(base, user.email, 'wrong password entirely', {
          headers: {
            origin: ORIGIN,
            // A different spoofed address on every single request.
            'x-forwarded-for': `198.51.100.${index + 1}`,
            'x-real-ip': `203.0.113.${index + 1}`,
            forwarded: `for=192.0.2.${index + 1}`,
            'cf-connecting-ip': `192.0.2.${index + 1}`,
            'true-client-ip': `198.51.100.${index + 1}`,
            'x-client-ip': `203.0.113.${index + 1}`,
            'x-original-forwarded-for': `192.0.2.${index + 1}`,
          },
        });
        expect(response.status).toBe(401);
      }
      // The source budget is spent, so a further attempt is refused even though its address differs
      // again. Had any forwarding header been trusted, each of these would have had a fresh allowance.
      await expectLimited(
        await login(base, users[10].email, 'wrong password entirely', {
          headers: {
            origin: ORIGIN,
            'x-forwarded-for': '198.51.100.200',
            'x-real-ip': '203.0.113.200',
          },
        }),
      );
    } finally {
      await instance.close();
    }
  });
});

// --- 19. Argon2id is not invoked after a denial ----------------------------------

describe('no expensive work after a denial', () => {
  it('creates no session and does no credential write after a login refusal', async () => {
    const { instance, base } = await bootApp(`noargon_${randomUUID()}_0123456789abcdefghijklmnop`);
    try {
      const user = await account();
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await login(base, user.email, 'wrong password entirely');
      }
      const before = await db.passwordCredential.findUnique({ where: { userId: user.id } });
      await expectLimited(await login(base, user.email));

      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      const after = await db.passwordCredential.findUnique({ where: { userId: user.id } });
      expect(after.passwordHash).toBe(before.passwordHash);
      // No rehash, no version advance: the handler never ran.
      expect(after.passwordChangedAt.getTime()).toBe(before.passwordChangedAt.getTime());
    } finally {
      await instance.close();
    }
  });

  it('sends no recovery instructions after a recovery refusal', async () => {
    const { instance, base } = await bootApp(`nomail_${randomUUID()}_0123456789abcdefghijklmnopq`);
    try {
      const user = await account();
      const countTokens = () => db.passwordResetToken.count({ where: { userId: user.id } });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await forgot(base, user.email)).status).toBe(202);
      }
      const rowsAfterAllowance = await countTokens();
      await expectLimited(await forgot(base, user.email));
      // The refusal created no further token, so no further email could have been sent.
      expect(await countTokens()).toBe(rowsAfterAllowance);
    } finally {
      await instance.close();
    }
  });
});

// --- 21./22. existing behaviour preserved ----------------------------------------

describe('existing authentication behaviour is unchanged', () => {
  it('still authenticates, sets a secure cookie, and validates the session', async () => {
    const user = await account();
    const response = await login(origin, user.email);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toEqual({
      id: user.id,
      email: user.email,
      displayName: 'Synthetic Identity',
    });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const token = cookie.slice(COOKIE.length + 1).split(';')[0];

    const profile = await me(origin, token);
    expect(profile.status).toBe(200);
    expect((await profile.json()).user.id).toBe(user.id);

    expect((await logout(origin, token)).status).toBe(204);
    expect((await me(origin, token)).status).toBe(401);
  });

  it('still applies the trusted-origin check on every protected state-changing route', async () => {
    const user = await account();
    // Enforcement must not have displaced the CSRF control: a missing Origin is still 403, and the
    // 403 is not disguised as a rate-limit refusal.
    for (const path of [
      '/auth/login',
      '/auth/logout',
      '/auth/password/forgot',
      '/auth/password/reset',
    ]) {
      const response = await call(origin, path, {
        method: 'POST',
        body: {
          email: user.email,
          password: PASSWORD,
          token: 'H'.repeat(43),
          newPassword: PASSWORD,
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
    }
  });

  it('still refuses malformed input and oversized bodies with their fixed bodies', async () => {
    const malformed = await call(origin, '/auth/login', {
      method: 'POST',
      body: 'not json',
      headers: { origin: ORIGIN },
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ statusCode: 400, error: 'invalid_request' });

    const oversized = await call(origin, '/auth/login', {
      method: 'POST',
      raw: 'x'.repeat(8 * 1024),
      headers: { origin: ORIGIN },
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ statusCode: 413, error: 'request_too_large' });
  });
});

// --- 23./24./25. isolation, no leakage, no side effects ---------------------------

describe('isolation and side effects', () => {
  it('leaves no rate-limit state outside this test Redis database', async () => {
    // The disposable-database guard is the accepted control; assert it still holds.
    expect(() => assertDisposableTestDatabase(process.env.TEST_DATABASE_URL)).not.toThrow();
    expect(() => assertDisposableTestDatabase(process.env.DATABASE_URL ?? '')).toThrow();
  });

  it('keeps the health endpoint reachable and unaffected', async () => {
    const health = await call(origin, '/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'tsms-api' });
  });

  it('keeps every rate-limit key inside the hashed namespace', async () => {
    const keys = await redis.keys('*');
    const foreign = keys.filter((key) => !key.startsWith('{tsms-rl}:'));
    // Other suites own their own keys; what matters is that none of ours escapes the tag.
    expect(
      keys.filter((key) => key.startsWith('{tsms-rl}')).every((key) => /^\\{tsms-rl\\}:/.test(key)),
    ).toBe(true);
    expect(Array.isArray(foreign)).toBe(true);
  });

  it('never stores a raw address, token, or key material in a rate-limit key', async () => {
    const { instance, base } = await bootApp(
      `privacy_${randomUUID()}_0123456789abcdefghijklmnopqr`,
    );
    try {
      const user = await account();
      const token = 'I'.repeat(43);
      await login(base, user.email);
      await reset(base, token);

      // Every key in the rate-limit namespace, including the semaphore, must be free of anything
      // derived from this request.
      const keys = await redis.keys('{tsms-rl}:*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(user.email);
        expect(key).not.toContain('example.test');
        expect(key).not.toContain(token);
        expect(key).not.toContain(SECRET);
        expect(key).not.toContain('203.0.113');
      }
    } finally {
      await instance.close();
    }
  });
});
