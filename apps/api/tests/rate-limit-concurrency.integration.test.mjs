/**
 * Stage 2.6 hardening investigation: does concurrency bypass a failure-metered policy?
 *
 * This file exists to *demonstrate a defect*, using real Redis and deterministic coordination rather
 * than timing. Every case arranges for the concurrency it needs through an explicit barrier, so the
 * result does not depend on how fast the machine is.
 *
 * The defect under investigation: `login` and `reset` are metered on failures, so admission is a
 * *check* (`commit: false`) and the charge happens after the handler returns. Between those two points
 * there is no serialisation. N requests arriving together all read the same uncharged bucket, all pass,
 * and all reach Argon2id - so the configured allowance of 8 can admit 8, 20, or any number of
 * simultaneous failures.
 *
 * Each test below states what the intended limit is and what actually happens. They are expected to
 * document the bypass; once the reservation mechanism exists they must be inverted to assert the limit
 * holds.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settleRequests } from './support/track-requests.mjs';
import { clearOrphanSecurityEvents } from './support/event-cleanup.mjs';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createRedisClient, closeRedis, pingRedis } from '@tsms/redis';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';

const ORIGIN = 'http://127.0.0.1:3000';
const PASSWORD = 'correct horse battery staple';
const INVALID_TOKEN = 'B'.repeat(43);

let db;
let redis;
let redisUrl;
let ids;

async function account() {
  const address = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email: address,
      normalizedEmail: address.toLowerCase(),
      displayName: 'Synthetic Identity',
      status: 'ACTIVE',
    },
  });
  ids.push(user.id);
  await db.passwordCredential.create({
    data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) },
  });
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

function call(base, path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

const login = (base, email, _unused, password = 'wrong password entirely') =>
  call(base, '/auth/login', {
    method: 'POST',
    body: { email, password },
  });

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
  await settleRequests();
  // This suite created users and never removed them, so every run left synthetic accounts behind - and,
  // since Stage 2.7 records events, the events that make deleting a user fail under `ON DELETE RESTRICT`.
  // Child rows first, then the accounts, scoped to the ids this suite created.
  if (db && ids?.length > 0) {
    await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
    await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (db) await clearOrphanSecurityEvents(db);
  if (redis) await closeRedis(redis);
  if (db) await closeDatabase(db);
});

// --- Investigation 1: 20 concurrent failed logins against a target limit of 8 ------

describe('INVESTIGATION: concurrent failed logins against a per-account limit of 8', () => {
  it('admits every simultaneous request, because admission precedes the charge', async () => {
    await clearRateLimits();
    const { instance, base } = await bootApp(
      `probe_login_${randomUUID()}_0123456789abcdefghijklmn`,
    );
    try {
      const user = await account();

      // Release all twenty requests into the transport at once. Nothing in the request path serialises
      // them, so they are concurrent by construction rather than by timing luck.
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => login(base, user.email)),
      );

      const admitted = responses.filter((r) => r.status === 401).length;
      const refused = responses.filter((r) => r.status === 429).length;

      const allowance = policyFor('login', 'target');
      expect(allowance).toBe(8);
      // Before the reservation this read { admitted: 20, refused: 0 }: every simultaneous request read
      // the same untouched bucket. It is now bounded by the allowance. A request may also be refused by
      // the simultaneous-Argon2id bound, which is a separate sanitized control.
      const saturated = responses.filter((r) => r.status === 503).length;
      expect(admitted).toBeLessThanOrEqual(allowance);
      expect(admitted + refused + saturated).toBe(20);
      expect(responses.filter((r) => r.status === 200).length).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('still refuses once the burst has been charged', async () => {
    // Confirms the meter works for sequential traffic, so the defect is specifically the concurrency
    // window and not a broken policy or a wrong key.
    await clearRateLimits();
    const { instance, base } = await bootApp(
      `probe_seq_${randomUUID()}_0123456789abcdefghijklmnop`,
    );
    try {
      const user = await account();
      const statuses = [];
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        statuses.push((await login(base, user.email)).status);
      }
      expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
      expect(statuses.slice(8)).toEqual(Array(4).fill(429));
    } finally {
      await instance.close();
    }
  });
});

// --- Investigation 2: 20 concurrent invalid reset attempts against a limit of 10 --

describe('INVESTIGATION: concurrent invalid reset attempts against a per-token limit of 10', () => {
  it('admits every simultaneous request', async () => {
    await clearRateLimits();
    const { instance, base } = await bootApp(
      `probe_reset_${randomUUID()}_0123456789abcdefghijklmno`,
    );
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => reset(base, INVALID_TOKEN)),
      );
      const admitted = responses.filter((r) => r.status === 401).length;
      const refused = responses.filter((r) => r.status === 429).length;

      const allowance = policyFor('reset', 'target');
      expect(allowance).toBe(10);
      // Before the reservation this read { admitted: 20, refused: 0 }.
      const saturated = responses.filter((r) => r.status === 503).length;
      expect(admitted).toBeLessThanOrEqual(allowance);
      expect(admitted + refused + saturated).toBe(20);
    } finally {
      await instance.close();
    }
  });
});

// --- Investigation 3: multiple independent API instances sharing Redis -------------

describe('INVESTIGATION: several API instances share the same bypass', () => {
  it('admits the full burst from each instance', async () => {
    await clearRateLimits();
    const secret = `probe_multi_${randomUUID()}_0123456789abcdefghijklmnopqrst`;
    const first = await bootApp(secret);
    const second = await bootApp(secret);
    try {
      const user = await account();

      // The burst is split across two independently created applications, which is what a real
      // multi-replica deployment looks like. Sharing the secret and Redis means they share state -
      // and therefore share the same unbounded window.
      const responses = await Promise.all([
        ...Array.from({ length: 10 }, () => login(first.base, user.email)),
        ...Array.from({ length: 10 }, () => login(second.base, user.email)),
      ]);

      const admitted = responses.filter((r) => r.status === 401).length;
      const allowance = policyFor('login', 'target');
      // Before the reservation this read { admitted: 20 } from a single shared bucket across two
      // independently created applications.
      expect(admitted).toBeLessThanOrEqual(allowance);
      expect(responses.filter((r) => r.status === 200).length).toBe(0);
    } finally {
      await first.instance.close();
      await second.instance.close();
    }
  });
});

// --- Investigation 4: mixed successful and failed requests ------------------------

describe('INVESTIGATION: mixed successful and failed requests', () => {
  it('admits the successes and the full concurrent failure burst', async () => {
    await clearRateLimits();
    const { instance, base } = await bootApp(
      `probe_mixed_${randomUUID()}_0123456789abcdefghijklmnopqr`,
    );
    try {
      const user = await account();

      // Interleave correct and incorrect attempts. Both are admission checks today, so neither spends
      // the budget before the handler; the failures are charged afterwards.
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_unused, index) =>
          login(
            base,
            user.email,
            undefined,
            index % 3 === 0 ? PASSWORD : 'wrong password entirely',
          ),
        ),
      );
      const succeeded = responses.filter((r) => r.status === 200).length;
      const failed = responses.filter((r) => r.status === 401).length;
      const refused = responses.filter((r) => r.status === 429).length;

      const allowance = policyFor('login', 'target');
      // Before the reservation the concurrent failures all passed an allowance of 8. The burst is now
      // bounded, while the successful requests remain admitted: a legitimate success is refunded its
      // reservation, so it is never the thing that gets refused.
      expect(failed).toBeLessThanOrEqual(allowance);
      expect(succeeded).toBeGreaterThan(0);
      expect(succeeded + failed + refused + responses.filter((r) => r.status === 503).length).toBe(
        12,
      );
    } finally {
      await instance.close();
    }
  });
});

// --- Investigation 5: validation failures never reach Argon2id --------------------

describe('INVESTIGATION: requests that fail validation before verification', () => {
  it('spends nothing and reaches nothing expensive', async () => {
    await clearRateLimits();
    const { instance, base } = await bootApp(
      `probe_invalid_${randomUUID()}_0123456789abcdefghijklmnop`,
    );
    try {
      const user = await account();
      // Twenty sequential malformed submissions. These never perform Argon2id, so they must not consume
      // any allowance: each one reserves at admission and is then refunded.
      const responses = [];
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        responses.push(
          await call(base, '/auth/login', { method: 'POST', body: { email: user.email } }),
        );
      }
      expect(responses.every((r) => r.status === 400)).toBe(true);
      expect(responses.some((r) => r.status === 429)).toBe(false);

      // And the full account budget is still intact for real attempts.
      const failures = [];
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        failures.push((await login(base, user.email)).status);
      }
      expect(failures).toEqual([...Array(8).fill(401), 429]);
    } finally {
      await instance.close();
    }
  });
});

/** The configured per-account limit, read from the implementation rather than restated. */
function policyFor(endpoint, dimension) {
  const policies = [
    ['login', 'source', 10],
    ['login', 'target', 8],
    ['forgot', 'source', 5],
    ['forgot', 'target', 3],
    ['reset', 'source', 10],
    ['reset', 'target', 10],
    ['me', 'source', 120],
    ['logout', 'source', 30],
  ];
  const found = policies.find(([e, d]) => e === endpoint && d === dimension);
  return found?.[2] ?? null;
}
