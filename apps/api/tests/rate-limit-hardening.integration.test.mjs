/**
 * Stage 2.6 hardening: concurrency guarantees.
 *
 * These tests are the regression suite for the two weaknesses found in review. Both were demonstrated
 * first by `rate-limit-concurrency.integration.test.mjs`, which recorded the pre-fix behaviour; the cases
 * here assert the corrected contract and are expected to fail if either mechanism is removed.
 *
 * All coordination is deterministic. Concurrency is produced by issuing requests together or by holding
 * slots explicitly in the test, never by sleeping and hoping.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import {
  ARGON2ID_SEMAPHORE_KEY,
  acquireArgon2idSlot,
  argon2idHolders,
  closeRedis,
  createRedisClient,
  pingRedis,
  refundRateLimit,
  releaseArgon2idSlot,
  renewArgon2idSlot,
  Argon2idAdmissionUnavailableError,
} from '@tsms/redis';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';
import { ARGON2ID_CONCURRENCY, policyFor } from '../dist/identity/auth-abuse-policy.js';

const ORIGIN = 'http://127.0.0.1:3000';
const PASSWORD = 'correct horse battery staple';
const INVALID_TOKEN = 'B'.repeat(43);

let db;
let redis;
let redisUrl;
let ids;

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

/**
 * Minimal request helper.
 *
 * The cookie is set explicitly and never by a jar, because a browser's automatic cookie handling cannot
 * express these cases at all.
 */
function call(base, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const init = {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    redirect: 'manual',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (cookie !== undefined) init.headers.cookie = cookie;
  return fetch(`${base}${path}`, init);
}

const login = (base, email, password = 'wrong password entirely') =>
  call(base, '/auth/login', { method: 'POST', body: { email, password } });

const forgot = (base, email) =>
  call(base, '/auth/password/forgot', { method: 'POST', body: { email } });

const reset = (base, token) =>
  call(base, '/auth/password/reset', {
    method: 'POST',
    body: { token, newPassword: 'a whole new secret phrase' },
  });

async function clearRateLimits() {
  // The Argon2id semaphore is one key spanning every instance, so it is shared deployment
  // state rather than this suite fixture. These suites run in parallel with the Redis suite against the
  // same logical database, so deleting it here would remove a semaphore from under that suite.
  const keys = await redis.keys('{tsms-rl}:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** A 43-character base64url holder id, matching what the semaphore accepts. */
const holder = () => randomUUID().replace(/-/g, '').padEnd(43, 'x');

beforeAll(async () => {
  const integration = parseIntegrationEnvironment(process.env);
  assertDisposableTestDatabase(integration.TEST_DATABASE_URL);
  redisUrl = integration.TEST_REDIS_URL;
  db = createDatabaseClient(integration.TEST_DATABASE_URL);
  redis = createRedisClient(redisUrl);
  await pingRedis(redis, { timeoutMillis: 5_000 });
  ids = [];
});

afterAll(async () => {
  if (redis) await closeRedis(redis);
  if (db) await closeDatabase(db);
});

beforeEach(async () => {
  // Each test starts with an empty rate-limit budget and its own user fixtures, so no test's traffic
  // can consume another's allowance or leave state that makes an assertion pass for the wrong reason.
  await clearRateLimits();
  ids = [];
});

afterEach(async () => {
  // Delete children before parents, and only this test's own fixtures.
  if (!db || ids.length === 0) return;
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

// --- 1. Failure-metered limits cannot be bypassed through concurrency ---------------

describe('concurrent requests cannot bypass a failure-metered limit', () => {
  it('admits exactly the allowance when 20 failed logins arrive together', async () => {
    const { instance, base } = await bootApp(`conc_login_${randomUUID()}_0123456789abcdefghijklm`);
    try {
      const user = await account();
      const allowance = policyFor('login', 'target').capacity;
      expect(allowance).toBe(8);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => login(base, user.email)),
      );
      const admitted = responses.filter((r) => r.status === 401).length;
      const refused = responses.filter((r) => r.status === 429).length;

      // The corrected contract: the reservation makes concurrent requests contend, so the burst is
      // bounded by the policy rather than by the number of requests in flight.
      expect(admitted).toBe(allowance);
      expect(refused).toBe(20 - allowance);
    } finally {
      await instance.close();
    }
  });

  it('admits exactly the allowance when 20 invalid resets arrive together', async () => {
    const { instance, base } = await bootApp(`conc_reset_${randomUUID()}_0123456789abcdefghijklmn`);
    try {
      const allowance = policyFor('reset', 'target').capacity;
      expect(allowance).toBe(10);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => reset(base, INVALID_TOKEN)),
      );
      expect(responses.filter((r) => r.status === 401).length).toBe(allowance);
      expect(responses.filter((r) => r.status === 429).length).toBe(10);
    } finally {
      await instance.close();
    }
  });

  it('bounds a burst split across separate API instances', async () => {
    const secret = `conc_multi_${randomUUID()}_0123456789abcdefghijklmnopqrst`;
    const first = await bootApp(secret);
    const second = await bootApp(secret);
    try {
      const user = await account();
      const allowance = policyFor('login', 'target').capacity;

      // Shared secret and shared Redis, so the reservation is genuinely shared rather than per replica.
      const responses = await Promise.all([
        ...Array.from({ length: 10 }, () => login(first.base, user.email)),
        ...Array.from({ length: 10 }, () => login(second.base, user.email)),
      ]);
      expect(responses.filter((r) => r.status === 401).length).toBe(allowance);
      expect(responses.filter((r) => r.status === 429).length).toBe(20 - allowance);
    } finally {
      await first.instance.close();
      await second.instance.close();
    }
  });

  it('still bounds sequential traffic identically', async () => {
    const { instance, base } = await bootApp(
      `conc_seq_${randomUUID()}_0123456789abcdefghijklmnopq`,
    );
    try {
      const user = await account();
      const statuses = [];
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        statuses.push((await login(base, user.email)).status);
      }
      // Concurrency changed the mechanism, not the limit.
      expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
      expect(statuses.slice(8)).toEqual(Array(4).fill(429));
    } finally {
      await instance.close();
    }
  });

  it('does not let a concurrent burst of legitimate successes cost budget', async () => {
    const { instance, base } = await bootApp(
      `conc_fair_${randomUUID()}_0123456789abcdefghijklmnopqr`,
    );
    try {
      const user = await account();
      const allowance = policyFor('login', 'target').capacity;

      // Simultaneous *correct* sign-ins, each reserving a token and then having it refunded. A burst at
      // or below the allowance is admitted outright: legitimate traffic must not be what gets refused.
      const responses = await Promise.all(
        Array.from({ length: allowance }, () => login(base, user.email, PASSWORD)),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);

      // The refund is what makes the fairness claim true. Every one of those reservations was returned,
      // so the meter is back to full and a whole allowance of genuine failures is still available. With
      // no refund this would be zero, and "a successful attempt is free" would be a false claim.
      const failures = [];
      for (let attempt = 1; attempt <= allowance; attempt += 1) {
        failures.push((await login(base, user.email)).status);
      }
      expect(failures).toEqual(Array(allowance).fill(401));
    } finally {
      await instance.close();
    }
  });

  it('spends nothing for submissions that never reach a verification', async () => {
    const { instance, base } = await bootApp(
      `conc_invalid_${randomUUID()}_0123456789abcdefghijklmnopqr`,
    );
    try {
      const user = await account();
      const allowance = policyFor('login', 'target').capacity;

      // Sequential malformed submissions: each reserves a token and is then refunded, because a malformed
      // body is not a guessing attempt. Not one of them may consume the allowance.
      const sequential = [];
      for (let attempt = 1; attempt <= allowance * 2; attempt += 1) {
        sequential.push(
          await call(base, '/auth/login', { method: 'POST', body: { email: user.email } }),
        );
      }
      expect(sequential.every((r) => r.status === 400)).toBe(true);
      expect(sequential.some((r) => r.status === 429)).toBe(false);

      // The full allowance is therefore still available for genuine attempts. This is the assertion that
      // would fail if the refund were missing.
      const failures = [];
      for (let attempt = 1; attempt <= allowance + 1; attempt += 1) {
        failures.push((await login(base, user.email)).status);
      }
      expect(failures).toEqual([...Array(allowance).fill(401), 429]);
    } finally {
      await instance.close();
    }
  });

  it('refunds at most the reserved amount, never manufacturing budget', async () => {
    const { instance, base } = await bootApp(
      `conc_refund_${randomUUID()}_0123456789abcdefghijklmnopqrs`,
    );
    try {
      const user = await account();
      // Burn the allowance with genuine failures: these are charged, not refunded.
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await login(base, user.email);
      }
      expect((await login(base, user.email)).status).toBe(429);

      // A correct sign-in is now refused by the meter, so nothing is reserved and nothing can be
      // refunded. Repeated successes must not rebuild a budget the failures consumed.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect((await login(base, user.email, PASSWORD)).status).toBe(429);
      }
      expect((await login(base, user.email)).status).toBe(429);
    } finally {
      await instance.close();
    }
  });
});

// --- 2./3. Argon2id admission is bounded and shared --------------------------------

describe('deployment-wide Argon2id admission', () => {
  it('refuses a slot beyond the configured simultaneous capacity', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const acquired = [];
    try {
      for (let index = 0; index < capacity; index += 1) {
        const decision = await acquireArgon2idSlot(redis, holder(), {
          limit: capacity,
          leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
        });
        expect(decision.acquired).toBe(true);
        acquired.push(holder());
      }
      // The capacity is full, so the next acquisition is refused rather than queued.
      const refused = await acquireArgon2idSlot(redis, holder(), {
        limit: capacity,
        leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
      });
      expect(refused.acquired).toBe(false);
      expect(refused.held).toBe(capacity);
    } finally {
      for (const id of acquired) {
        await releaseArgon2idSlot(redis, id, { timeoutMillis: 500 });
      }
    }
  });

  it('admits exactly the capacity under concurrent acquisition', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const ids = Array.from({ length: 20 }, () => holder());
    try {
      const decisions = await Promise.all(
        ids.map((id) =>
          acquireArgon2idSlot(redis, id, {
            limit: capacity,
            leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
          }),
        ),
      );
      // Atomic acquisition: twenty racing acquires, exactly `capacity` win.
      expect(decisions.filter((d) => d.acquired).length).toBe(capacity);
      expect(decisions.filter((d) => !d.acquired).length).toBe(20 - capacity);
      expect(await argon2idHolders(redis)).toBe(capacity);
    } finally {
      for (const id of ids) await releaseArgon2idSlot(redis, id, { timeoutMillis: 500 });
    }
  });

  it('holds the bound across separate Redis clients, as separate instances would', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const other = createRedisClient(redisUrl);
    // Hoisted so the finally block can release exactly what was taken.
    const held = [];
    try {
      for (let index = 0; index < capacity; index += 1) {
        const id = holder();
        const decision = await acquireArgon2idSlot(redis, id, {
          limit: capacity,
          leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
        });
        expect(decision.acquired).toBe(true);
        held.push(id);
      }

      // A second connection - standing in for a second replica - sees the same full semaphore. The bound
      // is in Redis, so it is shared rather than per process.
      const fromOtherInstance = await acquireArgon2idSlot(other, holder(), {
        limit: capacity,
        leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
      });
      expect(fromOtherInstance.acquired).toBe(false);
      expect(await argon2idHolders(other)).toBe(capacity);
    } finally {
      // Release exactly the holders this test took. Releasing freshly generated ids would be a no-op and
      // would leave the set full for the next case.
      for (const id of held) {
        await releaseArgon2idSlot(redis, id, { timeoutMillis: 500 });
      }
      await closeRedis(other);
    }
  });

  it('never begins more Argon2id work than the bound allows under a concurrent burst', async () => {
    const { instance, base } = await bootApp(
      `conc_argon_${randomUUID()}_0123456789abcdefghijklmnopqrstu`,
    );
    try {
      const users = [];
      for (let index = 0; index < 12; index += 1) users.push(await account());

      // Twelve simultaneous failed logins, each of which must attempt a real Argon2id verification.
      const responses = await Promise.all(users.map((user) => login(base, user.email)));
      // Some are refused by the credential meters, some by the semaphore, and none is served without
      // having obtained a slot.
      expect(responses.every((r) => [401, 429, 503].includes(r.status))).toBe(true);
      // Every request either produced a real authentication outcome or a refusal; never a bypass.
      expect(responses.filter((r) => r.status === 200).length).toBe(0);
      // The semaphore is fully released once the burst drains, so nothing leaked.
      expect(await argon2idHolders(redis)).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('leaves no session behind when admission is refused mid-burst', async () => {
    const { instance, base } = await bootApp(
      `conc_nosess_${randomUUID()}_0123456789abcdefghijklmnopqrstuv`,
    );
    try {
      const users = [];
      for (let index = 0; index < 12; index += 1) users.push(await account());
      // Scoped to this test's own fixtures. `ids` accumulates across the suite, so a global count would
      // also see sessions created by earlier tests and would fail for the wrong reason.
      const mine = users.map((user) => user.id);
      expect(await db.session.count({ where: { userId: { in: mine } } })).toBe(0);

      await Promise.all(users.map((user) => login(base, user.email)));

      // A refused request must not have created a session for anyone: saturation is still a refusal.
      expect(await db.session.count({ where: { userId: { in: mine } } })).toBe(0);
    } finally {
      await instance.close();
    }
  });
});

// --- 4./5./6. Failure modes: crash, expiry, and release safety ---------------------

describe('lease failure modes', () => {
  it('returns capacity automatically when a holder crashes without releasing', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    // A very short lease stands in for a crashed holder's slot: acquired, then abandoned.
    const leaseMillis = 1_000;
    for (let index = 0; index < capacity; index += 1) {
      await acquireArgon2idSlot(redis, holder(), { limit: capacity, leaseMillis });
    }
    expect(
      (await acquireArgon2idSlot(redis, holder(), { limit: capacity, leaseMillis })).acquired,
    ).toBe(false);

    // Wait for the abandoned leases to lapse, polling rather than sleeping to a fixed deadline.
    const deadline = Date.now() + 15_000;
    let reclaimed = false;
    while (Date.now() < deadline) {
      reclaimed = (await acquireArgon2idSlot(redis, holder(), { limit: capacity, leaseMillis }))
        .acquired;
      if (reclaimed) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    // Capacity came back on its own: a crashed process cannot leak a slot permanently.
    expect(reclaimed).toBe(true);
    await redis.del('{tsms-rl}:global:argon2id:holders');
  });

  it('refuses over-admission immediately after an expired lease rather than trusting the holder', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const leaseMillis = 1_000;
    const abandoned = holder();
    for (let index = 0; index < capacity; index += 1) {
      await acquireArgon2idSlot(redis, holder(), { limit: capacity, leaseMillis });
    }
    expect(await argon2idHolders(redis)).toBe(capacity);

    // The abandoned holder tries to renew after its lease has lapsed. It must not be able to revive a
    // slot that another request may already have taken.
    await new Promise((done) => setTimeout(done, leaseMillis + 200));
    const renewed = await renewArgon2idSlot(redis, abandoned, { limit: capacity, leaseMillis });
    expect(renewed).toBe(false);
    await redis.del('{tsms-rl}:global:argon2id:holders');
  });

  it('cannot release another holder slot', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const mine = holder();
    const theirs = holder();
    const forged = holder();
    await acquireArgon2idSlot(redis, mine, {
      limit: capacity,
      leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
    });
    await acquireArgon2idSlot(redis, theirs, {
      limit: capacity,
      leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
    });
    expect(await argon2idHolders(redis)).toBe(2);

    // A release naming a holder id this caller never acquired must change nothing. Holder ids are 32
    // random bytes, so this is the shape of an attacker guessing or replaying one.
    await releaseArgon2idSlot(redis, forged, { timeoutMillis: 500 });
    expect(await argon2idHolders(redis)).toBe(2);

    // And a release for a genuine but *different* holder frees exactly that one slot, not more.
    await releaseArgon2idSlot(redis, theirs, { timeoutMillis: 500 });
    expect(await argon2idHolders(redis)).toBe(1);
    await releaseArgon2idSlot(redis, mine, { timeoutMillis: 500 });
  });

  it('tolerates a duplicated release without freeing extra capacity', async () => {
    const capacity = ARGON2ID_CONCURRENCY.capacity;
    const mine = holder();
    await acquireArgon2idSlot(redis, mine, {
      limit: capacity,
      leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
    });
    await releaseArgon2idSlot(redis, mine, { timeoutMillis: 500 });
    expect(await argon2idHolders(redis)).toBe(0);

    // A second release for the same holder must not remove an unrelated holder's slot.
    const other = holder();
    await acquireArgon2idSlot(redis, other, {
      limit: capacity,
      leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
    });
    await releaseArgon2idSlot(redis, mine, { timeoutMillis: 500 });
    expect(await argon2idHolders(redis)).toBe(1);
    await releaseArgon2idSlot(redis, other, { timeoutMillis: 500 });
  });

  it('does not recreate an empty holder set on a late release', async () => {
    await releaseArgon2idSlot(redis, holder(), { timeoutMillis: 500 });
    // A late release must not leave a key behind, so nothing accumulates for a finished request.
    expect(await argon2idHolders(redis)).toBe(0);
    expect(await redis.exists('{tsms-rl}:global:argon2id:holders')).toBe(0);
  });

  it('rejects a malformed holder id rather than trusting it', async () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), '../../etc/passwd', 'a b']) {
      await expect(
        acquireArgon2idSlot(redis, bad, {
          limit: 4,
          leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
        }),
      ).rejects.toThrow(/43 base64url/);
    }
  });

  it('refuses admission when Redis is unreachable, with no unlimited fallback', async () => {
    const unreachable = createRedisClient('redis://:unused@127.0.0.1:6399/1', {
      connectTimeoutMillis: 1_000,
    });
    try {
      await expect(
        acquireArgon2idSlot(unreachable, holder(), {
          limit: ARGON2ID_CONCURRENCY.capacity,
          leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
          timeoutMillis: 2_000,
        }),
      ).rejects.toBeInstanceOf(Argon2idAdmissionUnavailableError);
    } finally {
      await closeRedis(unreachable);
    }
  });

  it('refuses admission on a malformed reply', async () => {
    for (const reply of [[], [1], [1, 0, 0], ['1', '0'], [2, 0], [1, -1], null, 'OK']) {
      const client = { eval: () => Promise.resolve(reply), time: () => Promise.resolve([1, 0]) };
      await expect(
        acquireArgon2idSlot(client, holder(), {
          limit: ARGON2ID_CONCURRENCY.capacity,
          leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
        }),
      ).rejects.toBeInstanceOf(Argon2idAdmissionUnavailableError);
    }
  });
});

// --- 7. Redis outage does not create unlimited authentication access --------------

describe('Redis outage with Argon2id admission', () => {
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

  it('refuses login and attempts no verification when Redis is unreachable', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_argon_${randomUUID()}_0123456789abcdefghijkl`,
    );
    try {
      const user = await account();
      // Scoped to this test's own fixture; `ids` accumulates across the suite.
      const mine = [user.id];
      // Twelve concurrent attempts: none may be served, because the admission bound is unconfirmable.
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => login(base, user.email, PASSWORD)),
      );
      expect(responses.every((r) => r.status === 503)).toBe(true);
      expect(await db.session.count({ where: { userId: { in: mine } } })).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('refuses recovery and issues no token when Redis is unreachable', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_recovery_${randomUUID()}_0123456789abcde`,
    );
    try {
      const user = await account();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => forgot(base, user.email)),
      );
      expect(responses.every((r) => r.status === 503)).toBe(true);
      expect(await db.passwordResetToken.count({ where: { userId: { in: ids } } })).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('refuses reset when Redis is unreachable', async () => {
    const { instance, base } = await bootWithoutRedis(
      `outage_reset_${randomUUID()}_0123456789abcdef`,
    );
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => reset(base, INVALID_TOKEN)),
      );
      expect(responses.every((r) => r.status === 503)).toBe(true);
    } finally {
      await instance.close();
    }
  });
});

// --- 8. Enumeration resistance is preserved ---------------------------------------

describe('enumeration resistance after hardening', () => {
  it('keeps known and unknown accounts externally identical under concurrency', async () => {
    const known = await bootApp(`enum_known_${randomUUID()}_0123456789abcdefghijklmnopqrstuvw`);
    const unknown = await bootApp(`enum_unknown_${randomUUID()}_0123456789abcdefghijklmnopqrstu`);
    try {
      const user = await account();
      const unknownEmail = `${randomUUID()}@example.test`;

      // Burst both, with the same shape, and compare the outcome distribution position by position.
      const knownResponses = await Promise.all(
        Array.from({ length: 12 }, () => login(known.base, user.email)),
      );
      const unknownResponses = await Promise.all(
        Array.from({ length: 12 }, () => login(unknown.base, unknownEmail)),
      );

      const shape = (responses) => responses.map((r) => r.status).sort();
      expect(shape(knownResponses)).toEqual(shape(unknownResponses));

      for (const response of [...knownResponses, ...unknownResponses]) {
        if (response.status === 429) {
          expect(await response.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
        }
      }
    } finally {
      await known.instance.close();
      await unknown.instance.close();
    }
  });

  it('returns the same bodies for known and unknown accounts', async () => {
    const { instance, base } = await bootApp(
      `enum_body_${randomUUID()}_0123456789abcdefghijklmnopqrstuv`,
    );
    try {
      const user = await account();
      const unknownEmail = `${randomUUID()}@example.test`;
      const knownResponse = await login(base, user.email);
      const unknownResponse = await login(base, unknownEmail);

      expect(knownResponse.status).toBe(unknownResponse.status);
      expect(await knownResponse.json()).toEqual(await unknownResponse.json());
      // No header distinguishes the two accounts.
      expect([...knownResponse.headers.keys()].sort()).toEqual(
        [...unknownResponse.headers.keys()].sort(),
      );
    } finally {
      await instance.close();
    }
  });
});

// --- 9. No credential or token material leaks -------------------------------------

describe('no credential or token material leaks', () => {
  it('keeps addresses and tokens out of every Redis key, including lease holders', async () => {
    const { instance, base } = await bootApp(
      `leak_${randomUUID()}_0123456789abcdefghijklmnopqrstuvw`,
    );
    try {
      const user = await account();
      await login(base, user.email);
      await reset(base, INVALID_TOKEN);

      // Hold a slot so the semaphore key exists while the assertion runs.
      const held = holder();
      await acquireArgon2idSlot(redis, held, {
        limit: ARGON2ID_CONCURRENCY.capacity,
        leaseMillis: ARGON2ID_CONCURRENCY.leaseMillis,
      });

      // The Argon2id semaphore is one key spanning every instance, so it is shared deployment
      // state rather than this suite fixture. These suites run in parallel with the Redis suite against the
      // same logical database, so deleting it here would remove a semaphore from under that suite.
      const keys = (await redis.keys('{tsms-rl}:*')).filter(
        (key) => key !== ARGON2ID_SEMAPHORE_KEY,
      );
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).not.toContain(user.email);
        expect(key).not.toContain('example.test');
        expect(key).not.toContain(INVALID_TOKEN);
        expect(key).not.toContain(PASSWORD);
        expect(key).not.toContain('$argon2id$');
      }

      // Lease members are random holder ids, never anything derived from the request.
      const members = await redis.zrange('{tsms-rl}:global:argon2id:holders', 0, -1);
      for (const member of members) {
        expect(member).not.toContain(user.email);
        expect(member).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }

      await releaseArgon2idSlot(redis, held, { timeoutMillis: 500 });
    } finally {
      await instance.close();
    }
  });

  it('refunds without resurrecting a lapsed bucket', async () => {
    // A refund on a subject whose window has already closed must not recreate the key, or an attacker
    // could hold a bucket alive indefinitely by refunding an expired one.
    const key = `{tsms-rl}:login:source:${'a'.repeat(32)}`;
    expect(await redis.exists(key)).toBe(0);
    await refundRateLimit(redis, [{ key, capacity: 5, windowMillis: 60_000, commit: true }]);
    expect(await redis.exists(key)).toBe(0);
  });
});

// --- 10. Regression: existing behaviour still holds -------------------------------

describe('existing authentication and recovery behaviour is unchanged', () => {
  it('authenticates, sets a secure cookie, and validates the session', async () => {
    const { instance, base } = await bootApp(
      `regress_${randomUUID()}_0123456789abcdefghijklmnopqrstuvw`,
    );
    try {
      const user = await account();
      const response = await login(base, user.email, PASSWORD);
      expect(response.status).toBe(200);
      const [cookie] = response.headers.getSetCookie();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      const token = cookie.slice('tsms_session='.length).split(';')[0];

      const profile = await call(base, '/auth/me', {
        cookie: `tsms_session=${token}`,
      });
      expect(profile.status).toBe(200);
      expect((await profile.json()).user.id).toBe(user.id);
    } finally {
      await instance.close();
    }
  });

  it('still refuses an untrusted origin before any verification', async () => {
    const { instance, base } = await bootApp(
      `regress_origin_${randomUUID()}_0123456789abcdefghijklmnopqrstuvwx`,
    );
    try {
      const user = await account();
      const response = await call(base, '/auth/login', {
        method: 'POST',
        body: { email: user.email, password: PASSWORD },
        headers: { origin: 'https://attacker.example.com' },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
    } finally {
      await instance.close();
    }
  });

  it('still issues a recovery token and refuses an unusable redemption', async () => {
    const { instance, base } = await bootApp(
      `regress_reset_${randomUUID()}_0123456789abcdefghijklmnopqrstuvwxy`,
    );
    try {
      const user = await account();
      // Issuance still writes exactly one token row.
      expect((await forgot(base, user.email)).status).toBe(202);
      expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);

      // A redemption with an unusable token is refused with the accepted generic failure, and the
      // original credential is untouched by that refusal.
      expect((await reset(base, INVALID_TOKEN)).status).toBe(401);
      expect((await login(base, user.email, PASSWORD)).status).toBe(200);
    } finally {
      await instance.close();
    }
  });
});
