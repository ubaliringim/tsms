import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_KEY_TAG } from '@tsms/redis';
import { AuthError, AuthService } from '../dist/identity/auth.service.js';
import {
  Argon2idAdmissionRefused,
  Argon2idAdmissionService,
  withArgon2idSlot,
} from '../dist/identity/argon2id-admission.service.js';
import { PasswordRecoveryService } from '../dist/identity/password-recovery.service.js';
import { PasswordCredentialError } from '../dist/identity/password-error.js';
import {
  AbuseProtectionService,
  dimensionsFor,
  refundableDimensionsFor,
} from '../dist/identity/abuse-protection.service.js';
import {
  deriveAbuseKey,
  globalWorkloadKey,
  GLOBAL_ARGON2ID_BUDGET,
  policyFor,
} from '../dist/identity/auth-abuse-policy.js';
import { AbuseReservationInterceptor } from '../dist/identity/abuse-reservation.interceptor.js';
import {
  ABUSE_DECISION,
  isWellFormedRequest,
  abuseContextFor,
} from '../dist/identity/auth-abuse.guard.js';
import { parseAuthBody } from '../dist/identity/auth-request-shape.js';

/**
 * Stage 2.9 remediation - deterministic unit tests (no Redis, no PostgreSQL).
 *
 * Covers F-01 (global budget charged only where Argon2id is admitted; malformed requests metered separately and
 * never refunded), F-02 (per-account success meter ordering), F-03 (exactly one verification per login path),
 * and F-08 (policy rejection versus internal hashing failure). The real-infrastructure behaviour is covered by
 * stage29-remediation.integration.test.mjs.
 */

const SECRET = 'stage29_unit_test_rate_limit_key_0123456789abcdef';
const EMAIL = 'person@example.test';
const HOLDER_RELEASE = /redis\.call\('ZREM'/;

// ---------------------------------------------------------------------------------------- helpers

/** A scripted Redis for the Argon2id semaphore and the rate-limit scripts. Counts what it is asked to do. */
function fakeRedis({ acquire = [1, 1], consume = [1, 0] } = {}) {
  const calls = { acquire: 0, release: 0, renew: 0, consume: [], refund: [], other: 0 };
  return {
    calls,
    time: () => Promise.resolve([1700000000, 0]),
    eval: (script, keyCount, ...args) => {
      if (script.includes('ZREMRANGEBYSCORE')) {
        calls.acquire += 1;
        return Promise.resolve(acquire);
      }
      if (HOLDER_RELEASE.test(script)) {
        calls.release += 1;
        return Promise.resolve(1);
      }
      if (script.includes('ZSCORE')) {
        calls.renew += 1;
        return Promise.resolve(1);
      }
      if (script.includes('HMGET') && !script.includes('allowed')) {
        // The refund script reads and rewrites buckets but makes no admission decision.
        calls.refund.push({ keyCount, args });
        return Promise.resolve(1);
      }
      if (script.includes('HMGET')) {
        calls.consume.push({ keyCount, args });
        return Promise.resolve(typeof consume === 'function' ? consume(keyCount, args) : consume);
      }
      calls.other += 1;
      return Promise.resolve(1);
    },
  };
}

const charged = { kind: 'charged' };
const workloadOf = (...outcomes) => {
  const seen = [];
  const queue = [...outcomes];
  return {
    seen,
    charge: async () => {
      seen.push('charge');
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

// =================================================================================== F-01: admission

describe('F-01 the global Argon2id budget is charged where Argon2id is admitted', () => {
  it('charges exactly once, and holds the slot until the permit is released', async () => {
    const redis = fakeRedis();
    const workload = workloadOf(charged);
    const admission = new Argon2idAdmissionService(redis, workload);
    const permit = await admission.acquire();
    expect(workload.seen).toEqual(['charge']);
    expect(redis.calls.acquire).toBe(1);
    expect(redis.calls.release).toBe(0);
    await permit.release();
    expect(redis.calls.release).toBe(1);
    expect(workload.seen).toHaveLength(1);
  });

  it('refuses before hashing when the budget is exhausted, with its retry hint, and returns the slot', async () => {
    const redis = fakeRedis();
    const admission = new Argon2idAdmissionService(
      redis,
      workloadOf({ kind: 'limited', retryAfterSeconds: 7 }),
    );
    const failure = await admission.acquire().then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Argon2idAdmissionRefused);
    expect(failure.refusal).toBe('budget');
    expect(failure.retryAfterSeconds).toBe(7);
    expect(redis.calls.release).toBe(1);
  });

  it('fails closed, and returns the slot, when the budget cannot be confirmed', async () => {
    const redis = fakeRedis();
    const admission = new Argon2idAdmissionService(redis, workloadOf({ kind: 'unavailable' }));
    const failure = await admission.acquire().then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Argon2idAdmissionRefused);
    expect(failure.refusal).toBe('unavailable');
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(redis.calls.release).toBe(1);
  });

  it('returns the slot and rethrows when the charge itself throws unexpectedly', async () => {
    const redis = fakeRedis();
    const boom = new Error('unexpected');
    const admission = new Argon2idAdmissionService(redis, workloadOf(boom));
    await expect(admission.acquire()).rejects.toBe(boom);
    expect(redis.calls.release).toBe(1);
  });

  it('does not charge a request the semaphore refused', async () => {
    const redis = fakeRedis({ acquire: [0, 8] });
    const workload = workloadOf(charged);
    const admission = new Argon2idAdmissionService(redis, workload);
    await expect(admission.acquire()).rejects.toMatchObject({ refusal: 'saturated' });
    expect(workload.seen).toHaveLength(0);
  });

  it('does not charge when the semaphore itself is unreachable', async () => {
    const workload = workloadOf(charged);
    const broken = {
      time: () => Promise.reject(new Error('down')),
      eval: () => Promise.reject(new Error('down')),
    };
    const admission = new Argon2idAdmissionService(broken, workload);
    await expect(admission.acquire()).rejects.toMatchObject({ refusal: 'unavailable' });
    expect(workload.seen).toHaveLength(0);
  });

  it('runs the work only after the charge, never on a refusal, and charges once even when the work throws', async () => {
    const order = [];
    const workload = { charge: async () => (order.push('charge'), charged) };
    const admission = new Argon2idAdmissionService(fakeRedis(), workload);
    await withArgon2idSlot(admission, async () => order.push('work'));
    expect(order).toEqual(['charge', 'work']);

    order.length = 0;
    await expect(
      withArgon2idSlot(admission, async () => {
        order.push('work');
        throw new Error('hashing failed');
      }),
    ).rejects.toThrow('hashing failed');
    expect(order).toEqual(['charge', 'work']);

    order.length = 0;
    const refusing = new Argon2idAdmissionService(
      fakeRedis(),
      workloadOf({ kind: 'limited', retryAfterSeconds: 1 }),
    );
    await expect(withArgon2idSlot(refusing, async () => order.push('work'))).rejects.toBeInstanceOf(
      Argon2idAdmissionRefused,
    );
    expect(order).toEqual([]);
  });
});

describe('F-01 charging the global budget through the abuse service', () => {
  const globalKey = globalWorkloadKey(SECRET);

  it('issues one atomic script on exactly the global key, committing one token', async () => {
    const redis = fakeRedis({ consume: [1, 0] });
    const service = new AbuseProtectionService({ secret: SECRET, redis });
    expect(await service.chargeGlobalWorkload()).toEqual({ kind: 'charged' });
    expect(redis.calls.consume).toHaveLength(1);
    const [{ keyCount, args }] = redis.calls.consume;
    expect(keyCount).toBe(1);
    expect(args).toEqual([
      globalKey,
      GLOBAL_ARGON2ID_BUDGET.capacity,
      GLOBAL_ARGON2ID_BUDGET.windowMillis,
      1,
    ]);
  });

  it('reports an exhausted budget with a bounded retry hint', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: fakeRedis({ consume: [0, 1500] }),
    });
    expect(await service.chargeGlobalWorkload()).toEqual({ kind: 'limited', retryAfterSeconds: 2 });
  });

  it('reports an unconfirmable budget as unavailable, never as charged', async () => {
    const broken = { eval: () => Promise.reject(new Error('ECONNREFUSED')) };
    const service = new AbuseProtectionService({ secret: SECRET, redis: broken });
    expect(await service.chargeGlobalWorkload()).toEqual({ kind: 'unavailable' });
    const unreadable = new AbuseProtectionService({
      secret: SECRET,
      redis: fakeRedis({ consume: ['x'] }),
    });
    expect(await unreadable.chargeGlobalWorkload()).toEqual({ kind: 'unavailable' });
  });
});

// ======================================================================= F-01: malformed requests

const context = (overrides = {}) => ({
  clientAddress: '203.0.113.10',
  normalizedEmail: EMAIL,
  recoveryToken: undefined,
  wellFormed: true,
  ...overrides,
});

describe('F-01 malformed requests have their own meter and nothing else', () => {
  it.each(['login', 'forgot', 'reset'])(
    '%s: one per-source dimension, reserved by nobody',
    (endpoint) => {
      const dimensions = dimensionsFor(SECRET, endpoint, context({ wellFormed: false }));
      expect(dimensions).toHaveLength(1);
      expect(dimensions[0].key).toBe(deriveAbuseKey(SECRET, endpoint, 'invalid', '203.0.113.10'));
      expect(dimensions[0].commit).toBe(true);
      expect(dimensions[0].capacity).toBe(policyFor(endpoint, 'invalid').capacity);
    },
  );

  it.each(['login', 'forgot', 'reset'])(
    '%s: never touches the credential, global, or success meters',
    (endpoint) => {
      const keys = dimensionsFor(SECRET, endpoint, context({ wellFormed: false })).map(
        (d) => d.key,
      );
      for (const forbidden of [
        deriveAbuseKey(SECRET, endpoint, 'source', '203.0.113.10'),
        deriveAbuseKey(SECRET, endpoint, 'target', EMAIL),
        deriveAbuseKey(SECRET, 'login', 'success', EMAIL),
        globalWorkloadKey(SECRET),
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    },
  );

  it('names no account: the key does not depend on the submitted address', () => {
    const a = dimensionsFor(
      SECRET,
      'login',
      context({ wellFormed: false, normalizedEmail: 'a@example.test' }),
    );
    const b = dimensionsFor(SECRET, 'login', context({ wellFormed: false, normalizedEmail: null }));
    expect(a[0].key).toBe(b[0].key);
  });

  it('is bounded: it is a finite per-source allowance, not an open door', () => {
    const policy = policyFor('login', 'invalid');
    expect(policy.capacity).toBeGreaterThan(0);
    expect(policy.capacity).toBeLessThanOrEqual(100);
    expect(policy.requiresEnforcement).toBe(true);
  });

  it('is refused when its own meter is exhausted, with the same limited decision', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: fakeRedis({ consume: [0, 4000] }),
    });
    expect(await service.decide('login', context({ wellFormed: false }))).toMatchObject({
      kind: 'limited',
      reserved: false,
      proceeds: false,
    });
  });

  it('fails closed on the malformed meter too, because the endpoint is fail-closed', async () => {
    const broken = { eval: () => Promise.reject(new Error('down')) };
    const service = new AbuseProtectionService({ secret: SECRET, redis: broken });
    for (const endpoint of ['login', 'forgot', 'reset']) {
      expect(await service.decide(endpoint, context({ wellFormed: false }))).toMatchObject({
        kind: 'unavailable',
        proceeds: false,
      });
    }
  });

  it('offers nothing to refund for a malformed request, even if asked', () => {
    for (const endpoint of ['login', 'forgot', 'reset']) {
      expect(
        refundableDimensionsFor(SECRET, endpoint, context({ wellFormed: false })),
      ).toHaveLength(0);
    }
  });

  it('records that nothing was reserved, so nothing can be refunded for it', async () => {
    const service = new AbuseProtectionService({ secret: SECRET, redis: fakeRedis() });
    expect((await service.decide('login', context({ wellFormed: false }))).reserved).toBe(false);
    expect((await service.decide('login', context())).reserved).toBe(true);
    expect(
      (await service.decide('reset', context({ recoveryToken: 'x'.repeat(43) }))).reserved,
    ).toBe(true);
    expect((await service.decide('forgot', context())).reserved).toBe(false);
  });
});

describe('request shape is decided by one definition', () => {
  const json = 'application/json';
  const ok = { email: 'a@example.test', password: 'whatever' };
  const login = (overrides) => ({
    headers: { 'content-type': json },
    body: ok,
    ...overrides,
  });

  it.each([
    ['a well-formed login', login({}), true],
    [
      'an empty password (a real, failing attempt)',
      login({ body: { email: 'a@example.test', password: '' } }),
      true,
    ],
    [
      'charset on the content type',
      login({ headers: { 'content-type': 'application/json; charset=utf-8' } }),
      true,
    ],
    [
      'a form content type',
      login({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      false,
    ],
    ['no content type', login({ headers: {} }), false],
    ['a missing field', login({ body: { email: 'a@example.test' } }), false],
    ['an extra field', login({ body: { ...ok, remember: 'yes' } }), false],
    ['a numeric password', login({ body: { email: 'a@example.test', password: 12345 } }), false],
    ['an array body', login({ body: [ok] }), false],
    ['no body', login({ body: undefined }), false],
    ['an empty address', login({ body: { email: '', password: 'x' } }), false],
    ['a blank address', login({ body: { email: '   ', password: 'x' } }), false],
    [
      'an address with a control character',
      login({ body: { email: 'a\u0000@example.test', password: 'x' } }),
      false,
    ],
    [
      'an over-long address',
      login({ body: { email: `${'a'.repeat(320)}@example.test`, password: 'x' } }),
      false,
    ],
  ])('login: %s', (_name, request, expected) => {
    expect(isWellFormedRequest('login', request)).toBe(expected);
  });

  it('reset and forgot use their own shapes', () => {
    const headers = { 'content-type': json };
    expect(
      isWellFormedRequest('reset', { headers, body: { token: 'a'.repeat(43), newPassword: 'x' } }),
    ).toBe(true);
    expect(
      isWellFormedRequest('reset', { headers, body: { token: 'a'.repeat(129), newPassword: 'x' } }),
    ).toBe(false);
    expect(isWellFormedRequest('reset', { headers, body: { token: 'a' } })).toBe(false);
    expect(isWellFormedRequest('forgot', { headers, body: { email: 'a@example.test' } })).toBe(
      true,
    );
    expect(
      isWellFormedRequest('forgot', { headers, body: { email: 'a@example.test', x: 1 } }),
    ).toBe(false);
  });

  it('never classifies me or logout as malformed', () => {
    expect(isWellFormedRequest('me', { headers: {} })).toBe(true);
    expect(isWellFormedRequest('logout', { headers: {}, body: 'anything' })).toBe(true);
  });

  it('agrees with the controller: both call parseAuthBody, so a shape the guard accepts the controller accepts', () => {
    for (const body of [ok, { email: '', password: '' }, { email: 'x', password: 1 }, []]) {
      const parsed = parseAuthBody('login', json, body);
      const guard = isWellFormedRequest('login', { headers: { 'content-type': json }, body });
      // The guard additionally needs a usable address; shape agreement is parsed !== null.
      if (!guard) continue;
      expect(parsed).not.toBeNull();
    }
    expect(
      abuseContextFor({ headers: { 'content-type': json }, body: ok, socket: {} }, 'login')
        .wellFormed,
    ).toBe(true);
  });
});

// =================================================================== F-01: the interceptor refunds

describe('the interceptor refunds only what was reserved', () => {
  function run({ reserved, outcome }) {
    const refunds = [];
    const protection = { refundFor: async (endpoint) => void refunds.push(endpoint) };
    const reflector = { getAllAndOverride: () => 'login' };
    const interceptor = new AbuseReservationInterceptor(protection, reflector);
    const request = {
      body: { email: EMAIL, password: 'x' },
      headers: { 'content-type': 'application/json' },
      socket: {},
    };
    Object.defineProperty(request, ABUSE_DECISION, { value: Object.freeze({ reserved }) });
    const context = {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    const handler = { handle: () => outcome() };
    return firstValueFrom(interceptor.intercept(context, handler)).then(
      () => ({ refunds, thrown: null }),
      (thrown) => ({ refunds, thrown }),
    );
  }

  it('never refunds a request that took no reservation (a malformed one), so no free tokens are minted', async () => {
    const result = await run({
      reserved: false,
      outcome: () => throwError(() => new AuthError('INVALID_REQUEST')),
    });
    expect(result.refunds).toHaveLength(0);
    expect(result.thrown.code).toBe('INVALID_REQUEST');
    // Not even a success refunds when nothing was reserved.
    expect((await run({ reserved: false, outcome: () => of('ok') })).refunds).toHaveLength(0);
  });

  it('keeps the charge for an authentication failure', async () => {
    const result = await run({
      reserved: true,
      outcome: () => throwError(() => new AuthError('AUTHENTICATION_FAILED')),
    });
    expect(result.refunds).toHaveLength(0);
  });

  it('refunds a success', async () => {
    expect((await run({ reserved: true, outcome: () => of('ok') })).refunds).toEqual(['login']);
  });

  it('refunds a refusal raised inside the handler by the global or success budget, and still propagates it', async () => {
    const result = await run({
      reserved: true,
      outcome: () => throwError(() => new AuthError('RATE_LIMITED', 9)),
    });
    expect(result.refunds).toEqual(['login']);
    expect(result.thrown.code).toBe('RATE_LIMITED');
    expect(result.thrown.retryAfterSeconds).toBe(9);
  });

  it('refunds a shape rejection that reached the handler, which should be impossible but must not be a charge', async () => {
    const result = await run({
      reserved: true,
      outcome: () => throwError(() => new AuthError('INVALID_REQUEST')),
    });
    expect(result.refunds).toEqual(['login']);
  });
});

// ================================================================================ F-02 and F-03

const REAL_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$c29tZXNhbHRzb21lc2FsdA$dGhpc2lzbm90YXJlYWxkaWdlc3RidXRzaGFwZWQ';

function loginHarness({ user, matches = false, meter = { kind: 'charged' } }) {
  const calls = { verify: [], transactions: 0, failures: [], charges: [], refunds: [], slots: 0 };
  const database = {
    user: { findUnique: async () => user },
    $transaction: async () => {
      calls.transactions += 1;
      throw new Error('session creation failed');
    },
  };
  const argon2id = {
    acquire: async () => {
      calls.slots += 1;
      return { release: async () => {} };
    },
  };
  const events = {
    detached: async (event) => void calls.failures.push(event),
    inTransaction: async () => {},
  };
  const securityLog = { record: () => {} };
  const successMeter = {
    charge: async (email) => (calls.charges.push(email), meter),
    refund: async (email) => void calls.refunds.push(email),
  };
  const verify = async (candidate, encoded) => {
    calls.verify.push(encoded);
    return typeof matches === 'function' ? matches(encoded) : { matches, needsRehash: false };
  };
  const service = new AuthService(
    database,
    {},
    argon2id,
    events,
    securityLog,
    successMeter,
    () => new Date(),
    verify,
  );
  const attempt = (password = 'a perfectly valid length password') =>
    service.login(EMAIL, password, 'a6f3c9d2-4b1e-4f7a-9c2d-3e5f6a7b8c9d').then(
      () => null,
      (error) => error,
    );
  return { calls, attempt };
}

const credential = { passwordHash: REAL_HASH, passwordChangedAt: new Date(1_700_000_000_000) };
const account = (overrides = {}) => ({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  email: EMAIL,
  displayName: 'Synthetic',
  status: 'ACTIVE',
  passwordCredential: credential,
  ...overrides,
});

describe('F-03 every login path performs exactly one verification', () => {
  const paths = [
    ['an existing active account with a wrong password', account(), REAL_HASH],
    ['an unknown address', null, null],
    ['a disabled account', account({ status: 'DISABLED' }), null],
    ['an active account with no credential record', account({ passwordCredential: null }), null],
  ];

  it.each(paths)('%s', async (_name, user, expectedDigest) => {
    const { calls, attempt } = loginHarness({ user });
    const failure = await attempt();
    expect(failure).toBeInstanceOf(AuthError);
    expect(failure.code).toBe('AUTHENTICATION_FAILED');
    // Exactly one verification, and never a second decoy verification after a real one.
    expect(calls.verify).toHaveLength(1);
    if (expectedDigest !== null) expect(calls.verify[0]).toBe(expectedDigest);
    else {
      // The decoy: a well-formed Argon2id digest that is not any account's.
      expect(calls.verify[0].startsWith('$argon2id$')).toBe(true);
      expect(calls.verify[0]).not.toBe(REAL_HASH);
    }
    expect(calls.transactions).toBe(0);
    expect(calls.charges).toHaveLength(0);
    expect(calls.failures).toHaveLength(1);
    expect(calls.failures[0].eventType).toBe('LOGIN_FAILED');
  });

  it('records the account for a real mismatch and no account for an unknown address', async () => {
    const real = loginHarness({ user: account() });
    await real.attempt();
    expect(real.calls.failures[0].userId).toBe(account().id);
    const unknown = loginHarness({ user: null });
    await unknown.attempt();
    expect(unknown.calls.failures[0].userId).toBeNull();
  });

  it.each(paths.slice(1))('never believes a match against the decoy: %s', async (_name, user) => {
    // A verifier that says "matches" for anything must still not authenticate an address that has no usable
    // credential. The result is only trusted when it was a verification against the account's own digest.
    const { calls, attempt } = loginHarness({ user, matches: true });
    const failure = await attempt();
    expect(failure.code).toBe('AUTHENTICATION_FAILED');
    expect(calls.transactions).toBe(0);
    expect(calls.charges).toHaveLength(0);
  });

  it('reports a verification failure as the same service failure on every path', async () => {
    for (const [, user] of paths) {
      const { attempt } = loginHarness({
        user,
        matches: () => {
          throw new Error('native failure');
        },
      });
      expect((await attempt()).code).toBe('SERVICE_FAILURE');
    }
  });
});

describe('F-01 a candidate that cannot be hashed takes no slot and spends no budget', () => {
  const SHORT = 'too short';

  it.each([
    ['an existing active account', account()],
    ['an unknown address', null],
    ['a disabled account', account({ status: 'DISABLED' })],
  ])('%s: a policy-invalid password is refused without an Argon2id slot', async (_name, user) => {
    const { calls, attempt } = loginHarness({ user });
    const failure = await attempt(SHORT);
    expect(failure.code).toBe('AUTHENTICATION_FAILED');
    // No slot, therefore no global-budget charge: the verifier rejects a policy-invalid candidate before Argon2id.
    expect(calls.slots).toBe(0);
    expect(calls.failures).toHaveLength(1);
    expect(calls.transactions).toBe(0);
    expect(calls.charges).toHaveLength(0);
  });

  it('takes exactly one slot for a candidate that will be hashed, on every path', async () => {
    for (const user of [
      account(),
      null,
      account({ status: 'DISABLED' }),
      account({ passwordCredential: null }),
    ]) {
      const { calls, attempt } = loginHarness({ user });
      await attempt();
      expect(calls.slots).toBe(1);
    }
  });

  it('is indistinguishable from a wrong password to the caller', async () => {
    const short = await loginHarness({ user: account() }).attempt(SHORT);
    const wrong = await loginHarness({ user: account() }).attempt();
    expect([short.code, short.message]).toEqual([wrong.code, wrong.message]);
  });

  it('never authenticates a policy-invalid candidate', async () => {
    const { calls, attempt } = loginHarness({ user: account(), matches: false });
    expect((await attempt(SHORT)).code).toBe('AUTHENTICATION_FAILED');
    expect(calls.transactions).toBe(0);
  });
});

describe('F-02 the success budget is charged after the password verifies and before a session exists', () => {
  it('charges once for an authenticated login, then refunds it when no session results', async () => {
    const { calls, attempt } = loginHarness({ user: account(), matches: true });
    const failure = await attempt();
    // The fake transaction fails, so no session was created.
    expect(failure.code).toBe('SERVICE_FAILURE');
    expect(calls.charges).toEqual([EMAIL]);
    expect(calls.transactions).toBe(1);
    expect(calls.refunds).toEqual([EMAIL]);
  });

  it('refuses a login whose account is at its success limit, before any session or event', async () => {
    const { calls, attempt } = loginHarness({
      user: account(),
      matches: true,
      meter: { kind: 'limited', retryAfterSeconds: 42 },
    });
    const failure = await attempt();
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.retryAfterSeconds).toBe(42);
    // Nothing was created, so no session and no LOGIN_SUCCEEDED event can exist for a refused success.
    expect(calls.transactions).toBe(0);
    expect(calls.refunds).toHaveLength(0);
    expect(calls.failures).toHaveLength(0);
  });

  it('fails closed when the success budget cannot be confirmed', async () => {
    const { calls, attempt } = loginHarness({
      user: account(),
      matches: true,
      meter: { kind: 'unavailable' },
    });
    expect((await attempt()).code).toBe('SERVICE_FAILURE');
    expect(calls.transactions).toBe(0);
  });

  it('never charges a failed attempt', async () => {
    const { calls, attempt } = loginHarness({ user: account(), matches: false });
    await attempt();
    expect(calls.charges).toHaveLength(0);
    expect(calls.refunds).toHaveLength(0);
  });

  it('meters exactly ten successes per ten minutes, provisionally', () => {
    const policy = policyFor('login', 'success');
    expect(policy.capacity).toBe(10);
    expect(policy.windowMillis).toBe(10 * 60_000);
    expect(policy.requiresEnforcement).toBe(true);
    // Only the account is metered. A per-source success meter would repeat the shared-source problem.
    expect(policyFor('login', 'success')).not.toBeNull();
    expect(policyFor('forgot', 'success')).toBeNull();
    expect(policyFor('reset', 'success')).toBeNull();
  });

  it('keys the success meter on the account, and consults it without spending it at admission', () => {
    const dimensions = dimensionsFor(SECRET, 'login', context());
    const success = dimensions.find(
      (d) => d.key === deriveAbuseKey(SECRET, 'login', 'success', EMAIL),
    );
    expect(success.commit).toBe(false);
    expect(refundableDimensionsFor(SECRET, 'login', context()).map((d) => d.key)).not.toContain(
      success.key,
    );
  });

  it('charges and refunds the success meter on its own key', async () => {
    const redis = fakeRedis({ consume: [1, 0] });
    const service = new AbuseProtectionService({ secret: SECRET, redis });
    expect(await service.chargeLoginSuccess(EMAIL)).toEqual({ kind: 'charged' });
    const [{ keyCount, args }] = redis.calls.consume;
    expect(keyCount).toBe(1);
    expect(args).toEqual([deriveAbuseKey(SECRET, 'login', 'success', EMAIL), 10, 600000, 1]);
    await service.refundLoginSuccess(EMAIL);
    expect(redis.calls.refund).toHaveLength(1);
    expect(redis.calls.refund[0].keyCount).toBe(1);
    expect(redis.calls.refund[0].args[0]).toBe(deriveAbuseKey(SECRET, 'login', 'success', EMAIL));
    const broken = new AbuseProtectionService({
      secret: SECRET,
      redis: { eval: () => Promise.reject(new Error('x')) },
    });
    await expect(broken.refundLoginSuccess(EMAIL)).resolves.toBeUndefined();
  });
});

// ======================================================================================= F-08

function recoveryHarness({ hash, acquire } = {}) {
  const calls = { hash: 0, slots: 0, released: 0, transactions: 0, updates: 0 };
  const database = {
    user: { findUnique: async () => null },
    passwordResetToken: {
      findUnique: async () => ({
        userId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async () => void (calls.updates += 1),
    },
    $transaction: async () => void (calls.transactions += 1),
  };
  const argon2id = {
    acquire:
      acquire ??
      (async () => {
        calls.slots += 1;
        return { release: async () => void (calls.released += 1) };
      }),
  };
  const hasher =
    hash ??
    (async () => {
      calls.hash += 1;
      return '$argon2id$v=19$m=65536,p=1,t=3$c29tZXNhbHRzb21lc2FsdA$aGFzaGVkaGFzaGVkaGFzaGVkaGFzaGVkaGFzaGVkaGE';
    });
  const service = new PasswordRecoveryService(
    database,
    { sendRecoveryInstructions: async () => {} },
    { mode: 'development-only', urlBase: 'https://app.example.test/recover' },
    argon2id,
    { inTransaction: async () => {}, revokeLiveSessionsRecordingEvents: async () => 0 },
    { record: () => {} },
    () => new Date(),
    async (candidate) => {
      calls.hash += 0;
      return hasher(candidate);
    },
  );
  const reset = (newPassword) =>
    service.resetPassword('A'.repeat(43), newPassword).then(
      () => null,
      (error) => error,
    );
  return { calls, reset, service };
}

describe('F-08 a hashing failure is not reported as a bad password', () => {
  const GOOD = 'a perfectly acceptable passphrase';

  it('answers a policy violation with INVALID_PASSWORD before any slot, budget, or hashing', async () => {
    const { calls, reset } = recoveryHarness();
    const failure = await reset('too short');
    expect(failure.code).toBe('INVALID_PASSWORD');
    expect(calls.slots).toBe(0);
    expect(calls.hash).toBe(0);
    expect(calls.transactions).toBe(0);
    expect(calls.updates).toBe(0);
  });

  it('answers an internal hashing failure with SERVICE_FAILURE and writes nothing', async () => {
    const { calls, reset } = recoveryHarness({
      hash: async () => {
        throw new PasswordCredentialError('HASH_FAILURE');
      },
    });
    const failure = await reset(GOOD);
    expect(failure.code).toBe('SERVICE_FAILURE');
    expect(failure.message).not.toContain('HASH_FAILURE');
    expect(calls.transactions).toBe(0);
    expect(calls.updates).toBe(0);
    // The slot was taken for the attempt and returned.
    expect(calls.slots).toBe(1);
    expect(calls.released).toBe(1);
  });

  it('answers any unexpected hashing error with SERVICE_FAILURE', async () => {
    const { calls, reset } = recoveryHarness({
      hash: async () => {
        throw new Error('out of memory');
      },
    });
    expect((await reset(GOOD)).code).toBe('SERVICE_FAILURE');
    expect(calls.transactions).toBe(0);
  });

  it("still maps the hasher's own policy rejection to INVALID_PASSWORD", async () => {
    const { reset } = recoveryHarness({
      hash: async () => {
        throw new PasswordCredentialError('INVALID_PASSWORD');
      },
    });
    expect((await reset(GOOD)).code).toBe('INVALID_PASSWORD');
  });

  it('answers an exhausted Argon2id budget with RATE_LIMITED and its hint, hashing nothing', async () => {
    const { calls, reset } = recoveryHarness({
      acquire: async () => {
        throw new Argon2idAdmissionRefused('budget', 0, 9);
      },
    });
    const failure = await reset(GOOD);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.retryAfterSeconds).toBe(9);
    expect(calls.hash).toBe(0);
    expect(calls.transactions).toBe(0);
  });

  it('answers a saturated or unavailable semaphore with SERVICE_FAILURE, unchanged', async () => {
    for (const refusal of ['saturated', 'unavailable']) {
      const { reset } = recoveryHarness({
        acquire: async () => {
          throw new Argon2idAdmissionRefused(refusal, 8);
        },
      });
      expect((await reset(GOOD)).code).toBe('SERVICE_FAILURE');
    }
  });

  it('does not let a budget refusal on forgot reveal whether the address is eligible', async () => {
    const { service } = recoveryHarness({
      acquire: async () => {
        throw new Argon2idAdmissionRefused('budget', 0, 5);
      },
    });
    // The unknown address would burn a verification; a refusal there must not become a 429 that an eligible
    // address (which performs no Argon2id) would not also produce.
    await expect(service.requestRecovery('nobody@example.test')).resolves.toBeUndefined();
  });
});

// ========================================================== every Argon2id entry point is slot-wrapped

describe('every HTTP-reachable Argon2id entry point passes through the admission choke point', () => {
  const sources = join(import.meta.dirname, '..', 'src');
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(dir, entry.name)]
          : [],
    );
  const read = (path) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const all = files(sources).map((path) => ({
    path,
    name: path.split(/[\\/]/).pop(),
    text: read(path),
  }));

  it('imports the Argon2id package only inside the hasher', () => {
    const importers = all.filter((f) => /from 'argon2'/.test(f.text)).map((f) => f.name);
    expect(importers).toEqual(['password-hasher.ts']);
  });

  it('lets only the two HTTP-reachable services and the credential primitive import the hasher', () => {
    const importers = all
      .filter((f) => /from '\.\/password-hasher\.js'/.test(f.text))
      .map((f) => f.name)
      .sort();
    expect(importers).toEqual([
      'auth.service.ts',
      'password-credential.service.ts',
      'password-recovery.service.ts',
    ]);
  });

  it('keeps the credential primitive (which hashes without a slot) out of every HTTP path', () => {
    const importers = all
      .filter((f) => /password-credential\.service\.js/.test(f.text))
      .map((f) => f.name)
      .sort();
    // `auth.service.ts` imports only the digest-fingerprint helper; `auth.module.ts` provides the primitive.
    expect(importers).toEqual(['auth.module.ts', 'auth.service.ts']);
    const auth = all.find((f) => f.name === 'auth.service.ts').text;
    expect(auth).toMatch(/import \{ fingerprintOf \} from '\.\/password-credential\.service\.js'/);
    expect(auth).not.toMatch(/PasswordCredentialService/);
  });

  it('runs every verification and hash in the HTTP services inside withArgon2idSlot', () => {
    const auth = all.find((f) => f.name === 'auth.service.ts').text;
    const recovery = all.find((f) => f.name === 'password-recovery.service.ts').text;
    // login: the whole verification, real and decoy, is inside one slot.
    expect(auth).toMatch(/const attempt = \(\) => this\.verifyAndCreateSession\(/);
    expect(auth).toMatch(/withArgon2idSlot\(this\.argon2id, attempt\)/);
    // A candidate that cannot be hashed bypasses the slot, and so the budget, and nothing else.
    expect(auth).toMatch(/validatePassword\(password\)\.valid/);
    expect(auth.match(/this\.verify\(/g)).toHaveLength(1);
    expect(auth).not.toMatch(/burnVerification/);
    // recovery: the decoy burn and the reset hash both go through `guarded`, which wraps the slot.
    expect(recovery).toMatch(/withArgon2idSlot\(this\.argon2id, work\)/);
    expect(recovery).toMatch(/this\.guarded\(\(\) => this\.burnVerification\(\)/);
    expect(recovery).toMatch(/this\.guarded\(\(\) => this\.hash\(newPassword\)/);
    expect(recovery.match(/verifyPassword\(/g)).toHaveLength(1);
  });

  it('charges the global budget in the admission service and nowhere else', () => {
    const chargers = all
      .filter((f) => /chargeGlobalWorkload\(\)/.test(f.text))
      .map((f) => f.name)
      .sort();
    expect(chargers).toEqual(['abuse-protection.service.ts', 'auth.module.ts']);
    const admission = all.find((f) => f.name === 'argon2id-admission.service.ts').text;
    expect((admission.match(/this\.workload\.charge\(\)/g) ?? []).length).toBe(1);
  });

  it('keeps every rate-limit key inside the one hash-tagged namespace', () => {
    for (const endpoint of ['login', 'forgot', 'reset']) {
      for (const dimension of dimensionsFor(SECRET, endpoint, context({ wellFormed: false }))) {
        expect(dimension.key.startsWith(`{${RATE_LIMIT_KEY_TAG}}:`)).toBe(true);
      }
    }
  });
});
