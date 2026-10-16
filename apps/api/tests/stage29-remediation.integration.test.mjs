import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleRequests } from './support/track-requests.mjs';
import { clearOrphanSecurityEvents } from './support/event-cleanup.mjs';
import { resetRateLimitState } from './support/rate-limit-state.mjs';
import { admissionFor, successMeterFor } from './support/stage29-wiring.mjs';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { ARGON2ID_SEMAPHORE_KEY, createRedisClient, closeRedis } from '@tsms/redis';
import { createApplication } from '../dist/application.js';
import { hashPassword, verifyPassword } from '../dist/identity/password-hasher.js';
import { SessionService } from '../dist/identity/session.service.js';
import { AuthService } from '../dist/identity/auth.service.js';
import { PasswordRecoveryService } from '../dist/identity/password-recovery.service.js';
import { PasswordCredentialError } from '../dist/identity/password-error.js';
import { InMemoryRecoveryDelivery } from '../dist/identity/password-recovery-delivery.js';
import { SecurityEventRecorder } from '../dist/identity/security-event-recorder.js';
import { SecurityLog } from '../dist/identity/security-log.js';
import { RECOVERY_DELIVERY } from '../dist/identity/auth.module.js';
import {
  ARGON2ID_CONCURRENCY,
  deriveAbuseKey,
  globalWorkloadKey,
} from '../dist/identity/auth-abuse-policy.js';
import { AbuseProtectionService } from '../dist/identity/abuse-protection.service.js';
import { Argon2idAdmissionService } from '../dist/identity/argon2id-admission.service.js';

/**
 * Stage 2.9 remediation against real PostgreSQL and Redis.
 *
 * F-01  malformed requests do not spend the global Argon2id budget and have their own bounded meter
 * F-02  one account cannot monopolise login capacity with successful logins
 * F-03  every login path performs exactly one verification (real database, real Redis, real hashing)
 * F-08  a policy violation is a 400, an internal hashing failure is a 503, and neither disturbs the token
 * F-09  concurrent recovery issuance leaves exactly one live token
 *
 * Request counts are bounded and every account is synthetic. The limiter is reset before each test.
 */

const ORIGIN = 'http://127.0.0.1:3000';
const SECRET = 'stage29_integration_rate_limit_key_0123456789abcd';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'entirely different secret phrase';
const RECOVERY_BASE = 'https://app.example.test/account/recover';
const integrationEnv = parseIntegrationEnvironment(process.env);

let db, redis, app, base, delivery, ids;

beforeAll(async () => {
  const databaseUrl = assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  redis = createRedisClient(integrationEnv.TEST_REDIS_URL);
  app = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: integrationEnv.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [ORIGIN],
    API_RATE_LIMIT_HMAC_SECRET: SECRET,
    API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
    API_PASSWORD_RECOVERY_URL_BASE: RECOVERY_BASE,
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  delivery = app.get(RECOVERY_DELIVERY, { strict: false });
});

afterAll(async () => {
  await app?.close();
  if (redis) await closeRedis(redis);
  if (db) await closeDatabase(db);
});

beforeEach(async () => {
  await resetRateLimitState(integrationEnv.TEST_REDIS_URL);
  delivery.clear();
  ids = [];
});

afterEach(async () => {
  await settleRequests();
  await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
  await clearOrphanSecurityEvents(db);
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', credential = true } = {}) {
  const email = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email, normalizedEmail: email, displayName: 'Synthetic Identity', status },
  });
  ids.push(user.id);
  if (credential) {
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) },
    });
  }
  return user;
}

const call = (path, { body, origin = ORIGIN, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const login = (email, password = PASSWORD) => call('/auth/login', { body: { email, password } });
const forgot = (email) => call('/auth/password/forgot', { body: { email } });
const malformedLogin = () => call('/auth/login', { body: { email: '', password: 'x' } });

const bucket = async (key) => {
  const [tokens] = await redis.hmget(key, 't');
  return tokens === null ? null : Number(tokens) / 1000;
};
const GLOBAL = globalWorkloadKey(SECRET);
const loginSource = () => deriveAbuseKey(SECRET, 'login', 'source', '127.0.0.1');
const loginTarget = (email) => deriveAbuseKey(SECRET, 'login', 'target', email);

/** Empty the global Argon2id bucket, as if a window's worth of real hashing had just been admitted. */
async function emptyGlobalBudget() {
  const [seconds, micros] = await redis.time();
  await redis.hset(GLOBAL, 't', 0, 'm', Number(seconds) * 1000 + Math.floor(Number(micros) / 1000));
  await redis.pexpire(GLOBAL, 60_000);
}

const statusesOf = async (promises) => {
  const responses = await Promise.all(promises);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  return responses.map((response) => response.status);
};
const liveTokens = (userId) =>
  db.passwordResetToken.count({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } } });

// ======================================================================================== F-01

describe('F-01 the global Argon2id budget is spent only by real Argon2id work', () => {
  it('is not spent by malformed logins, which leave the credential meters untouched too', async () => {
    const user = await account();
    for (let i = 0; i < 25; i += 1) {
      const response = await malformedLogin();
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    expect(await bucket(GLOBAL)).toBeNull();
    expect(await bucket(loginSource())).toBeNull();
    // A correct login right afterwards is unaffected, from the very same source.
    expect((await login(user.email)).status).toBe(200);
  });

  it('is not spent by a malformed body that names an account, and does not charge that account', async () => {
    const user = await account();
    for (let i = 0; i < 10; i += 1) {
      const response = await call('/auth/login', { body: { email: user.email, password: 12345 } });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    expect(await bucket(loginTarget(user.email))).toBeNull();
    expect(await bucket(GLOBAL)).toBeNull();
    // The account still has its whole failure allowance: eight wrong passwords before any refusal.
    const statuses = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await login(user.email, WRONG)).status);
    expect(statuses).toEqual(Array(8).fill(401));
  });

  it('bounds malformed requests on their own meter, so they are not free', async () => {
    const statuses = [];
    for (let i = 0; i < 32; i += 1) {
      const response = await malformedLogin();
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(statuses.slice(30)).toEqual([429, 429]);
    // The refusal is the ordinary one, with a bounded retry hint.
    const refused = await malformedLogin();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9]\d?$/);
    expect(await refused.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
  });

  it('does not let malformed traffic block a well-formed login from the same source', async () => {
    const user = await account();
    for (let i = 0; i < 31; i += 1) {
      const response = await malformedLogin();
      await response.arrayBuffer();
    }
    expect((await malformedLogin()).status).toBe(429);
    // The malformed meter is separate, so a real sign-in from the same address is untouched.
    expect((await login(user.email)).status).toBe(200);
  });

  it('keeps the same bounded meter on the recovery endpoints', async () => {
    const forgotStatuses = [];
    const resetStatuses = [];
    for (let i = 0; i < 31; i += 1) {
      const a = await call('/auth/password/forgot', { body: {} });
      const b = await call('/auth/password/reset', { body: {} });
      forgotStatuses.push(a.status);
      resetStatuses.push(b.status);
      await a.arrayBuffer();
      await b.arrayBuffer();
    }
    expect(forgotStatuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(forgotStatuses[30]).toBe(429);
    expect(resetStatuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(resetStatuses[30]).toBe(429);
    expect(await bucket(GLOBAL)).toBeNull();
  });

  it('is spent exactly once by a real login, and not refunded by its success', async () => {
    const user = await account();
    expect((await login(user.email)).status).toBe(200);
    const level = await bucket(GLOBAL);
    expect(level).toBeGreaterThan(118.9);
    expect(level).toBeLessThan(119.2);
    // The credential meters were reserved and then returned; the budget was not.
    expect(await bucket(loginSource())).toBe(10);
  });

  it('is spent by the work and not by the request: an ineligible forgot hashes, an eligible one does not', async () => {
    const eligible = await account();
    expect((await forgot(eligible.email)).status).toBe(202);
    expect(await bucket(GLOBAL)).toBeNull();
    expect((await forgot(`${randomUUID()}@example.test`)).status).toBe(202);
    const level = await bucket(GLOBAL);
    expect(level).toBeGreaterThan(118.9);
    expect(level).toBeLessThan(119.2);
  });

  it('is not spent by a password-policy rejection on reset, which performs no hashing', async () => {
    const user = await account();
    await forgot(user.email);
    await resetLimiterOnly();
    const response = await call('/auth/password/reset', {
      body: { token: delivery.last.token, newPassword: 'too short' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'password_policy_violation' });
    expect(await bucket(GLOBAL)).toBeNull();
    expect(await liveTokens(user.id)).toBe(1);
  });

  it('refuses before hashing, with Retry-After, once the budget is exhausted, and writes nothing', async () => {
    const user = await account();
    await emptyGlobalBudget();
    const response = await login(user.email);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^[1-9]\d?$/);
    expect(await response.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.authenticationEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses login, forgot, and reset alike while the budget is exhausted, so eligibility is not revealed', async () => {
    const eligible = await account();
    await emptyGlobalBudget();
    const statuses = await statusesOf([
      forgot(eligible.email),
      forgot(`${randomUUID()}@example.test`),
      login(eligible.email, WRONG),
    ]);
    expect(statuses).toEqual([429, 429, 429]);
  });

  it('serves again as soon as the budget has a token', async () => {
    const user = await account();
    await emptyGlobalBudget();
    expect((await login(user.email)).status).toBe(429);
    await redis.del(GLOBAL);
    expect((await login(user.email)).status).toBe(200);
  });

  it('keeps the fail-closed behaviour when the budget cannot be confirmed', async () => {
    const user = await account();
    const broken = await createApplication({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      DATABASE_URL: assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL),
      // Nothing listens here, so every Redis command fails.
      REDIS_URL: 'redis://:x@127.0.0.1:1/1',
      API_TRUSTED_ORIGINS: [ORIGIN],
      API_RATE_LIMIT_HMAC_SECRET: SECRET,
    });
    await broken.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${await broken.getUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: user.email, password: PASSWORD }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ statusCode: 503, error: 'service_unavailable' });
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await broken.close();
    }
  });
});

/** Clear limiter state without touching the rows a test just created. */
const resetLimiterOnly = () => resetRateLimitState(integrationEnv.TEST_REDIS_URL);

// ======================================================================================== F-02

describe('F-02 one account cannot monopolise login capacity', () => {
  it('allows ten successes per window, then refuses the correct password with Retry-After', async () => {
    const user = await account();
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await login(user.email);
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toMatch(/^[1-9]\d?$/);
        expect(await response.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
      } else {
        await response.arrayBuffer();
      }
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429, 429]);
  });

  it('creates no session and no LOGIN_SUCCEEDED event for a refused success', async () => {
    const user = await account();
    for (let i = 0; i < 13; i += 1) await (await login(user.email)).arrayBuffer();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(10);
    const events = await db.authenticationEvent.findMany({ where: { userId: user.id } });
    expect(events.filter((e) => e.eventType === 'LOGIN_SUCCEEDED')).toHaveLength(10);
    expect(events.filter((e) => e.eventType === 'LOGIN_FAILED')).toHaveLength(0);
  });

  it('answers a wrong password the same way once the account is at its limit, so there is no oracle', async () => {
    const user = await account();
    for (let i = 0; i < 10; i += 1) await (await login(user.email)).arrayBuffer();
    const correct = await login(user.email, PASSWORD);
    const wrong = await login(user.email, WRONG);
    expect([correct.status, wrong.status]).toEqual([429, 429]);
    expect(await correct.text()).toBe(await wrong.text());
  });

  it('is per account: another account on the same source is unaffected', async () => {
    const busy = await account();
    const other = await account();
    for (let i = 0; i < 11; i += 1) await (await login(busy.email)).arrayBuffer();
    expect((await login(busy.email)).status).toBe(429);
    expect((await login(other.email)).status).toBe(200);
  });

  it('is not consumed by failed attempts', async () => {
    const user = await account();
    for (let i = 0; i < 5; i += 1) await (await login(user.email, WRONG)).arrayBuffer();
    const statuses = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await login(user.email)).status);
    expect(statuses).toEqual(Array(10).fill(200));
  });

  it('spends the global Argon2id budget for each real login, because hashing really ran', async () => {
    const user = await account();
    const started = Date.now();
    for (let i = 0; i < 4; i += 1) await (await login(user.email)).arrayBuffer();
    const level = await bucket(GLOBAL);
    const refilled = (2 * (Date.now() - started)) / 1000; // the bucket refills 120 tokens per minute
    // Four tokens were spent. The level can only be higher than 116 by what refilled while the logins ran.
    expect(level).toBeGreaterThanOrEqual(115.9);
    expect(level).toBeLessThanOrEqual(116 + refilled + 0.3);
  });

  it('holds under concurrency: simultaneous logins never exceed the limit, and sessions match events', async () => {
    const user = await account();
    const first = await statusesOf(Array.from({ length: 6 }, () => login(user.email)));
    const second = await statusesOf(Array.from({ length: 6 }, () => login(user.email)));
    const all = [...first, ...second];
    // A busy Argon2id semaphore may answer 503; nothing else is possible, and nothing exceeds ten.
    expect(all.every((status) => [200, 429, 503].includes(status))).toBe(true);
    const succeeded = all.filter((status) => status === 200).length;
    expect(succeeded).toBeLessThanOrEqual(10);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(succeeded);
    const events = await db.authenticationEvent.count({
      where: { userId: user.id, eventType: 'LOGIN_SUCCEEDED' },
    });
    expect(events).toBe(succeeded);
    if (!all.includes(503)) expect(succeeded).toBe(10);
  });
});

// ======================================================================================== F-03

describe('F-03 every login path performs exactly one verification, against real infrastructure', () => {
  function service(counter) {
    const log = new SecurityLog({ sink: () => {} });
    return new AuthService(
      db,
      new SessionService(db),
      admissionFor(redis),
      new SecurityEventRecorder(db, log),
      log,
      successMeterFor(redis),
      () => new Date(),
      async (candidate, encoded) => {
        counter.calls += 1;
        counter.digests.push(encoded);
        return verifyPassword(candidate, encoded);
      },
    );
  }
  const attempt = async (email, password) => {
    const counter = { calls: 0, digests: [] };
    const outcome = await service(counter)
      .login(email, password)
      .then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, code: error.code }),
      );
    return { ...outcome, counter };
  };

  it('counts one verification on each path, including a success', async () => {
    const active = await account();
    const disabled = await account({ status: 'DISABLED' });
    const bare = await account({ credential: false });
    const unknown = `${randomUUID()}@example.test`;
    const stored = (await db.passwordCredential.findUnique({ where: { userId: active.id } }))
      .passwordHash;

    const results = {
      wrong: await attempt(active.email, WRONG),
      unknown: await attempt(unknown, WRONG),
      disabled: await attempt(disabled.email, WRONG),
      noCredential: await attempt(bare.email, WRONG),
      success: await attempt(active.email, PASSWORD),
    };
    for (const [name, outcome] of Object.entries(results)) {
      expect(outcome.counter.calls, name).toBe(1);
    }
    expect(results.wrong.counter.digests[0]).toBe(stored);
    expect(results.success.counter.digests[0]).toBe(stored);
    for (const name of ['unknown', 'disabled', 'noCredential']) {
      expect(results[name].counter.digests[0], name).not.toBe(stored);
    }
    expect(results.wrong).toMatchObject({ ok: false, code: 'AUTHENTICATION_FAILED' });
    expect(results.unknown).toMatchObject({ ok: false, code: 'AUTHENTICATION_FAILED' });
    expect(results.disabled).toMatchObject({ ok: false, code: 'AUTHENTICATION_FAILED' });
    expect(results.noCredential).toMatchObject({ ok: false, code: 'AUTHENTICATION_FAILED' });
    expect(results.success.ok).toBe(true);
    expect(await db.session.count({ where: { userId: active.id } })).toBe(1);
  });

  it('still refuses a login whose credential changed after verification', async () => {
    const user = await account();
    const log = new SecurityLog({ sink: () => {} });
    const racing = new AuthService(
      db,
      new SessionService(db),
      admissionFor(redis),
      new SecurityEventRecorder(db, log),
      log,
      successMeterFor(redis),
      () => new Date(),
      async (candidate, encoded) => {
        const outcome = await verifyPassword(candidate, encoded);
        // A reset lands between the verification and the session insert.
        await db.passwordCredential.update({
          where: { userId: user.id },
          data: {
            passwordHash: await hashPassword('a brand new passphrase'),
            passwordChangedAt: new Date(),
          },
        });
        return outcome;
      },
    );
    await expect(racing.login(user.email, PASSWORD)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    // The success budget was returned, because no session resulted.
    const level = await bucket(deriveAbuseKey(SECRET, 'login', 'success', user.email));
    expect(level === null || level >= 9.9).toBe(true);
  });
});

// ======================================================================================== F-08

describe('F-08 hashing failures are not reported as a bad password', () => {
  function recoveryWith(hash) {
    const log = new SecurityLog({ sink: () => {} });
    return new PasswordRecoveryService(
      db,
      new InMemoryRecoveryDelivery(),
      { mode: 'development-only', urlBase: RECOVERY_BASE },
      admissionFor(redis),
      new SecurityEventRecorder(db, log),
      log,
      () => new Date(),
      hash,
    );
  }

  async function issued() {
    const user = await account();
    await forgot(user.email);
    return { user, token: delivery.last.token };
  }

  it('answers a policy violation with 400 and leaves the token and credential alone', async () => {
    const { user, token } = await issued();
    const before = (await db.passwordCredential.findUnique({ where: { userId: user.id } }))
      .passwordHash;
    const response = await call('/auth/password/reset', { body: { token, newPassword: 'short' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'password_policy_violation' });
    expect(await liveTokens(user.id)).toBe(1);
    expect(
      (await db.passwordCredential.findUnique({ where: { userId: user.id } })).passwordHash,
    ).toBe(before);
  });

  it.each([
    ['a native hashing failure', () => new PasswordCredentialError('HASH_FAILURE')],
    ['an allocation failure', () => new Error('Cannot allocate memory')],
  ])(
    'answers %s with a service failure, and leaves the token and credential alone',
    async (_name, make) => {
      const { user, token } = await issued();
      const before = (await db.passwordCredential.findUnique({ where: { userId: user.id } }))
        .passwordHash;
      const service = recoveryWith(async () => {
        throw make();
      });
      const failure = await service.resetPassword(token, 'a perfectly acceptable passphrase').then(
        () => null,
        (error) => error,
      );
      expect(failure.code).toBe('SERVICE_FAILURE');
      expect(failure.message).not.toMatch(/HASH_FAILURE|allocate/);
      expect(await liveTokens(user.id)).toBe(1);
      expect(
        (await db.passwordCredential.findUnique({ where: { userId: user.id } })).passwordHash,
      ).toBe(before);
      expect(
        await db.authenticationEvent.count({
          where: { userId: user.id, eventType: 'PASSWORD_RESET_COMPLETED' },
        }),
      ).toBe(0);
      // The same token still works once hashing recovers.
      await recoveryWith(hashPassword).resetPassword(token, 'a perfectly acceptable passphrase');
      expect(await liveTokens(user.id)).toBe(0);
    },
  );
});

// ======================================================================================== F-09

describe('F-09 recovery issuance is serialised per user', () => {
  it('leaves exactly one live token after three simultaneous requests', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await account();
      await resetLimiterOnly();
      const statuses = await statusesOf([
        forgot(user.email),
        forgot(user.email),
        forgot(user.email),
      ]);
      expect(statuses).toEqual([202, 202, 202]);
      expect(await liveTokens(user.id)).toBe(1);
    }
  });

  it('leaves exactly one live token after two simultaneous requests following an earlier token', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await account();
      await resetLimiterOnly();
      expect((await forgot(user.email)).status).toBe(202);
      const statuses = await statusesOf([forgot(user.email), forgot(user.email)]);
      expect(statuses).toEqual([202, 202]);
      expect(await liveTokens(user.id)).toBe(1);
    }
  });

  it('leaves exactly one live token after sequential requests, each superseding the last', async () => {
    const user = await account();
    for (let i = 0; i < 3; i += 1) expect((await forgot(user.email)).status).toBe(202);
    expect(await liveTokens(user.id)).toBe(1);
    expect(delivery.deliveries).toHaveLength(3);
    // Only the newest link works.
    const [older] = delivery.deliveries;
    const stale = await call('/auth/password/reset', {
      body: { token: older.token, newPassword: 'a perfectly acceptable passphrase' },
    });
    expect(stale.status).toBe(401);
  });

  it('keeps single-use semantics: a token redeems once and supersedes the others', async () => {
    const user = await account();
    await forgot(user.email);
    const { token } = delivery.last;
    const first = await call('/auth/password/reset', {
      body: { token, newPassword: 'a perfectly acceptable passphrase' },
    });
    expect(first.status).toBe(204);
    const replay = await call('/auth/password/reset', {
      body: { token, newPassword: 'another acceptable passphrase' },
    });
    expect(replay.status).toBe(401);
    expect(await liveTokens(user.id)).toBe(0);
  });

  it('never leaves two live tokens when issuance races a reset', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await account();
      await resetLimiterOnly();
      await forgot(user.email);
      const { token } = delivery.last;
      const [resetStatus, forgotStatus] = await statusesOf([
        call('/auth/password/reset', {
          body: { token, newPassword: 'a perfectly acceptable passphrase' },
        }),
        forgot(user.email),
      ]);
      expect(forgotStatus).toBe(202);
      // Either the reset won (the new token is the only live one) or issuance superseded the old token first
      // (the reset is refused as an unusable token). Never both live.
      expect([204, 401]).toContain(resetStatus);
      expect(await liveTokens(user.id)).toBeLessThanOrEqual(1);
    }
  });
});

// ============================================================================ final inspection

const NEW_PASSWORD = 'a perfectly acceptable passphrase';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

describe('inspection F-01: the global budget under concurrency, and slots on every exit', () => {
  it('does not spend the budget on a well-formed login whose password cannot be hashed', async () => {
    const user = await account();
    for (let i = 0; i < 5; i += 1) {
      const response = await login(user.email, 'too short');
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(await bucket(GLOBAL)).toBeNull();
  });

  it('cannot be bypassed by simultaneous requests: three tokens admit exactly three logins', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => account()));
    await resetLimiterOnly();
    const [seconds, micros] = await redis.time();
    await redis.hset(
      GLOBAL,
      't',
      3000,
      'm',
      Number(seconds) * 1000 + Math.floor(Number(micros) / 1000),
    );
    await redis.pexpire(GLOBAL, 60_000);

    // The admission check sees three tokens, so every request passes it. Only the atomic charge decides.
    const responses = await Promise.all(users.map((user) => login(user.email)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    for (const response of responses.filter((r) => r.status === 429)) {
      // A refusal raised inside the handler carries the same contract as one raised by the guard.
      expect(response.headers.get('retry-after')).toMatch(/^[1-9]\d?$/);
      expect(await response.json()).toEqual({ statusCode: 429, error: 'rate_limited' });
    }
    await Promise.all(responses.filter((r) => r.status !== 429).map((r) => r.arrayBuffer()));

    expect(await db.session.count({ where: { userId: { in: users.map((u) => u.id) } } })).toBe(3);
    const events = await db.authenticationEvent.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
    });
    expect(events.filter((e) => e.eventType === 'LOGIN_SUCCEEDED')).toHaveLength(3);
    expect(events.filter((e) => e.eventType === 'LOGIN_FAILED')).toHaveLength(0);
    // Every reservation came back, including those of the refused requests, which attempted nothing.
    expect(await bucket(loginSource())).toBe(10);
    // And every slot was returned.
    expect(await redis.zcard(ARGON2ID_SEMAPHORE_KEY)).toBe(0);
  });

  it('returns the slot when the budget refuses, and when the charge itself throws', async () => {
    const protection = new AbuseProtectionService({ secret: SECRET, redis });
    await emptyGlobalBudget();
    const refusing = new Argon2idAdmissionService(
      redis,
      { charge: () => protection.chargeGlobalWorkload() },
      ARGON2ID_CONCURRENCY,
    );
    for (let i = 0; i < 4; i += 1) {
      await expect(refusing.acquire()).rejects.toMatchObject({ refusal: 'budget' });
      expect(await redis.zcard(ARGON2ID_SEMAPHORE_KEY)).toBe(0);
    }
    const throwing = new Argon2idAdmissionService(
      redis,
      {
        charge: async () => {
          throw new Error('unexpected');
        },
      },
      ARGON2ID_CONCURRENCY,
    );
    await expect(throwing.acquire()).rejects.toThrow('unexpected');
    expect(await redis.zcard(ARGON2ID_SEMAPHORE_KEY)).toBe(0);
  });

  it('gives a malformed request no refund, so it cannot buy back its own failed logins', async () => {
    const user = await account();
    // The account's own failure meter allows eight; a ninth would be refused at the guard and charge nothing.
    for (let i = 0; i < 8; i += 1) await (await login(user.email, WRONG)).arrayBuffer();
    const before = await bucket(loginSource());
    const targetBefore = await bucket(loginTarget(user.email));
    expect(before).toBeLessThan(2.5);
    expect(targetBefore).toBeLessThan(1);
    for (let i = 0; i < 20; i += 1) {
      const response = await call('/auth/login', { body: { email: user.email, password: 12345 } });
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    // A bucket refills slowly with time (10 per 5 minutes); a refund would have raised it by one per request.
    expect(await bucket(loginSource())).toBeLessThan(before + 0.5);
    expect(await bucket(loginTarget(user.email))).toBeLessThan(targetBefore + 0.5);
  });
});

describe('inspection F-02: the success meter', () => {
  const meter = () => successMeterFor(redis, SECRET);
  const successKey = (email) => deriveAbuseKey(SECRET, 'login', 'success', email);

  it('never credits a bucket beyond capacity, and never creates one that has expired', async () => {
    const email = `${randomUUID()}@example.test`;
    // No key: a refund is a no-op, not a way to mint a full bucket.
    await meter().refund(email);
    expect(await bucket(successKey(email))).toBeNull();
    // One charge then many refunds: clamped at capacity.
    expect(await meter().charge(email)).toEqual({ kind: 'charged' });
    expect(await bucket(successKey(email))).toBe(9);
    for (let i = 0; i < 5; i += 1) await meter().refund(email);
    expect(await bucket(successKey(email))).toBe(10);
  });

  it('refuses the eleventh concurrent charge, however the requests interleave', async () => {
    const email = `${randomUUID()}@example.test`;
    const outcomes = await Promise.all(Array.from({ length: 16 }, () => meter().charge(email)));
    expect(outcomes.filter((o) => o.kind === 'charged')).toHaveLength(10);
    expect(outcomes.filter((o) => o.kind === 'limited')).toHaveLength(6);
  });

  it('answers a correct and a wrong password identically once an account is at its limit', async () => {
    const user = await account();
    for (let i = 0; i < 10; i += 1) await (await login(user.email)).arrayBuffer();
    const correct = await login(user.email, PASSWORD);
    const wrong = await login(user.email, WRONG);
    expect(correct.status).toBe(429);
    expect(wrong.status).toBe(429);
    expect(await correct.text()).toBe(await wrong.text());
    expect(correct.headers.get('retry-after')).toBe(wrong.headers.get('retry-after'));
    // No credential oracle: the password is not consulted, so nothing about it can show.
    expect(
      await db.authenticationEvent.count({ where: { userId: user.id, eventType: 'LOGIN_FAILED' } }),
    ).toBe(0);
  });

  it('documents the one residual signal: an account at its own limit refuses where an unknown address would not', async () => {
    // Pinned rather than hidden. It is not remotely exploitable against an arbitrary account, because only a
    // holder of the account's password can fill its success bucket; the signal reveals that a heavy user exists
    // only to someone who already controls that account. Any change to this is a visible decision.
    const user = await account();
    for (let i = 0; i < 10; i += 1) await (await login(user.email)).arrayBuffer();
    const saturated = await login(user.email, WRONG);
    const unknown = await login(`${randomUUID()}@example.test`, WRONG);
    expect(saturated.status).toBe(429);
    expect(unknown.status).toBe(401);
  });
});

describe('inspection F-03 and F-09: one lock, taken first, by every participant', () => {
  function recoveryService(hash) {
    const log = new SecurityLog({ sink: () => {} });
    return new PasswordRecoveryService(
      db,
      new InMemoryRecoveryDelivery(),
      { mode: 'development-only', urlBase: RECOVERY_BASE },
      admissionFor(redis),
      new SecurityEventRecorder(db, log),
      log,
      () => new Date(),
      hash,
    );
  }

  it('refuses a token that issuance superseded while the reset was still hashing', async () => {
    const user = await account();
    await forgot(user.email);
    const stale = delivery.last.token;
    const before = (await db.passwordCredential.findUnique({ where: { userId: user.id } }))
      .passwordHash;

    const hashing = deferred();
    const release = deferred();
    const parked = recoveryService(async (candidate) => {
      hashing.resolve();
      await release.promise;
      return hashPassword(candidate);
    });
    const pending = parked.resetPassword(stale, NEW_PASSWORD).then(
      () => null,
      (error) => error,
    );

    // The reset has claimed the token and is inside its hash, outside any transaction. Issuance now supersedes it.
    await hashing.promise;
    await resetLimiterOnly();
    expect((await forgot(user.email)).status).toBe(202);
    release.resolve();

    const failure = await pending;
    expect(failure?.code).toBe('RECOVERY_TOKEN_INVALID');
    expect(
      (await db.passwordCredential.findUnique({ where: { userId: user.id } })).passwordHash,
    ).toBe(before);
    expect(await liveTokens(user.id)).toBe(1);
    // The newer token is the one that works.
    const fresh = await call('/auth/password/reset', {
      body: { token: delivery.last.token, newPassword: NEW_PASSWORD },
    });
    expect(fresh.status).toBe(204);
  });

  it('completes a mixed round of logins, issuance, and a reset with no deadlock and a consistent result', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await account();
      await resetLimiterOnly();
      await forgot(user.email);
      const { token } = delivery.last;

      const everything = Promise.all([
        login(user.email),
        login(user.email),
        login(user.email),
        forgot(user.email),
        call('/auth/password/reset', { body: { token, newPassword: NEW_PASSWORD } }),
      ]);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('deadlock suspected')), 40_000),
      );
      const responses = await Promise.race([everything, timeout]);
      const statuses = responses.map((r) => r.status);
      await Promise.all(responses.map((r) => r.arrayBuffer()));

      expect(statuses.slice(0, 3).every((s) => [200, 401, 429, 503].includes(s))).toBe(true);
      expect(statuses[3]).toBe(202);
      expect([204, 401]).toContain(statuses[4]);
      expect(await liveTokens(user.id)).toBeLessThanOrEqual(1);

      const sessions = await db.session.findMany({ where: { userId: user.id } });
      if (statuses[4] === 204) {
        // The reset won. No session may outlive it: those that committed first were revoked by it, and a login that
        // verified the old password afterwards was refused by the in-lock revalidation.
        expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
        await resetLimiterOnly();
        expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
        expect((await login(user.email, PASSWORD)).status).toBe(401);
      } else {
        // Issuance superseded the token first: the credential is unchanged and the old password still works.
        await resetLimiterOnly();
        expect((await login(user.email, PASSWORD)).status).toBe(200);
      }
    }
  });
});
