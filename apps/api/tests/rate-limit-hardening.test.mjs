/**
 * Unit tests for the Stage 2.6 hardening primitives: the Argon2id semaphore and the reservation refund.
 *
 * A fake client cannot demonstrate atomicity or lease expiry, so those live in
 * `rate-limit.integration.test.mjs` against a real Redis. What is testable here is everything that
 * decides whether a call is *allowed to be made at all*: input validation, reply interpretation, and the
 * refusal classification. Those are precisely the places where a permissive default would be a silent
 * bypass, so they are asserted directly.
 */

import { describe, expect, it } from 'vitest';
import {
  acquireArgon2idSlot,
  releaseArgon2idSlot,
  renewArgon2idSlot,
  Argon2idAdmissionUnavailableError,
  ARGON2ID_SEMAPHORE_KEY,
  RATE_LIMIT_KEY_TAG,
} from '@tsms/redis';
import { refundRateLimit, RATE_LIMIT_KEY_TAG as LIMIT_TAG } from '@tsms/redis';
import {
  ARGON2ID_CONCURRENCY,
  countsEveryRequest,
  policyFor,
  globalWorkloadKey,
  deriveAbuseKey,
  GLOBAL_ARGON2ID_BUDGET,
  retryAfterSeconds,
  MAX_RETRY_AFTER_SECONDS,
} from '../dist/identity/auth-abuse-policy.js';
import {
  dimensionsFor,
  refundableDimensionsFor,
} from '../dist/identity/abuse-protection.service.js';
import { Argon2idAdmissionRefused } from '../dist/identity/argon2id-admission.service.js';
import { CHARGED_ERROR_CODES } from '../dist/identity/abuse-reservation.interceptor.js';

const SECRET = 'stage26_hardening_unit_test_rate_limit_key_0123456789';
const HOLDER = 'A'.repeat(43);
const LEASE = 30_000;

/** A client whose eval returns a fixed reply and whose clock reads a fixed instant. */
const stub = (reply) => ({
  eval: () => Promise.resolve(reply),
  time: () => Promise.resolve([1700000000, 500000]),
});

describe('Argon2id semaphore key and holder identity', () => {
  it('shares the limiter hash tag, so the key can never collide with a bucket', () => {
    // A different hash tag would place the two key families in different slots, and a collision or a
    // wrong-type operation between them would be a real failure mode.
    expect(ARGON2ID_SEMAPHORE_KEY).toBe(`{${RATE_LIMIT_KEY_TAG}}:global:argon2id:holders`);
    expect(ARGON2ID_SEMAPHORE_KEY.match(/\{[^}]+\}/g)).toEqual([`{${RATE_LIMIT_KEY_TAG}}`]);
  });

  it('is inside the namespace the integration cleanup and privacy assertions cover', () => {
    expect(ARGON2ID_SEMAPHORE_KEY.startsWith(`{${LIMIT_TAG}}:`)).toBe(true);
  });

  it('accepts only a 43-character base64url holder id', async () => {
    // 32 random bytes is the only accepted shape. Anything else is a configuration fault rather than a
    // value to coerce, because a predictable holder id would let one request release another's slot.
    // A lowercase id of the right length is deliberately absent: base64url is case-sensitive, so it is
    // legitimately valid and rejecting it would reject roughly half of all real holder ids.
    for (const bad of [
      '',
      'x',
      'A'.repeat(42),
      'A'.repeat(44),
      'A'.repeat(42) + '!',
      'A B'.padEnd(43, 'C'),
      '='.repeat(43),
    ]) {
      await expect(
        acquireArgon2idSlot(stub([1, 1]), bad, { limit: 4, leaseMillis: LEASE }),
      ).rejects.toThrow(/43 base64url/);
    }
    await expect(
      acquireArgon2idSlot(stub([1, 1]), HOLDER, { limit: 4, leaseMillis: LEASE }),
    ).resolves.toEqual({ acquired: true, held: 1 });
  });
});

describe('Argon2id admission configuration', () => {
  it('bounds simultaneous work above the accepted legitimate concurrency', () => {
    // The accepted Stage 2.5 contract includes "six concurrent valid logins are all admitted". A bound
    // below that would refuse legitimate traffic, which is worse than the burst it prevents.
    expect(ARGON2ID_CONCURRENCY.capacity).toBeGreaterThanOrEqual(8);
  });

  it('makes the lease far longer than a verification and the renewal far shorter than the lease', () => {
    expect(ARGON2ID_CONCURRENCY.leaseMillis).toBeGreaterThanOrEqual(30_000);
    expect(ARGON2ID_CONCURRENCY.renewIntervalMillis).toBeLessThan(ARGON2ID_CONCURRENCY.leaseMillis);
    expect(ARGON2ID_CONCURRENCY.timeoutMillis).toBeGreaterThan(0);
  });

  it('keeps the concurrency bound distinct from the rate budget', () => {
    // Conflating the two is the weakness the review found: a per-minute budget says nothing about how much
    // runs at once.
    expect(ARGON2ID_CONCURRENCY.capacity).toBeLessThan(GLOBAL_ARGON2ID_BUDGET.capacity);
  });
});

describe('Argon2id admission refuses rather than degrades', () => {
  it('reports a saturated semaphore distinctly from an unavailable one', async () => {
    const saturated = await acquireArgon2idSlot(stub([0, 8]), HOLDER, {
      limit: 4,
      leaseMillis: LEASE,
    });
    expect(saturated).toEqual({ acquired: false, held: 8 });
    // A full semaphore is a capacity condition; an unknown bound is an infrastructure condition. They are
    // deliberately distinguishable internally so neither can be reported as the other.
    expect(new Argon2idAdmissionRefused('saturated', 8).refusal).toBe('saturated');
    expect(new Argon2idAdmissionRefused('unavailable', 0).refusal).toBe('unavailable');
  });

  it('never treats an unreadable reply as a granted slot', async () => {
    for (const reply of [
      [],
      [1],
      [1, 0, 0],
      ['1', '1'],
      [2, 0],
      [1, -1],
      [1, 1.5],
      null,
      'OK',
      [1, null],
    ]) {
      await expect(
        acquireArgon2idSlot(stub(reply), HOLDER, { limit: 4, leaseMillis: LEASE }),
      ).rejects.toBeInstanceOf(Argon2idAdmissionUnavailableError);
    }
  });

  it('never treats an unreadable clock as a granted slot', async () => {
    // Redis replies to TIME with bulk strings. A client that coerced them wrongly would otherwise hand out
    // a slot against a clock of zero, which would expire every outstanding lease at once.
    for (const reply of [null, [], ['x', 'y'], [1700000000], 'nope']) {
      const client = { eval: () => Promise.resolve([1, 1]), time: () => Promise.resolve(reply) };
      await expect(
        acquireArgon2idSlot(client, HOLDER, { limit: 4, leaseMillis: LEASE }),
      ).rejects.toBeInstanceOf(Argon2idAdmissionUnavailableError);
    }
  });

  it('accepts the string clock Redis actually returns', async () => {
    const client = {
      eval: () => Promise.resolve([1, 1]),
      time: () => Promise.resolve(['1700000000', '500000']),
    };
    await expect(
      acquireArgon2idSlot(client, HOLDER, { limit: 4, leaseMillis: LEASE }),
    ).resolves.toEqual({ acquired: true, held: 1 });
  });

  it('rejects a non-positive or fractional limit', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        acquireArgon2idSlot(stub([1, 1]), HOLDER, { limit, leaseMillis: LEASE }),
      ).rejects.toThrow(/limit/);
    }
  });

  it('rejects an unbounded or too-short lease', async () => {
    // A lease that never expires would leak capacity permanently after a crash; one shorter than a
    // verification would expire under a healthy operation and permit over-admission.
    for (const leaseMillis of [0, 999, 600_001, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        acquireArgon2idSlot(stub([1, 1]), HOLDER, { limit: 4, leaseMillis }),
      ).rejects.toThrow(/lease/);
    }
  });

  it('swallows a release failure so a finished operation cannot fail', async () => {
    // The caller has already done its work; the lease expiry is the backstop that returns the slot.
    const broken = { eval: () => Promise.reject(new Error('ECONNRESET')) };
    await expect(
      releaseArgon2idSlot(broken, HOLDER, { timeoutMillis: 100 }),
    ).resolves.toBeUndefined();
  });

  it('rejects a malformed holder id on release rather than issuing the command', async () => {
    let called = false;
    const client = {
      eval: () => {
        called = true;
        return Promise.resolve(1);
      },
    };
    await expect(releaseArgon2idSlot(client, 'short', {})).rejects.toThrow(/43 base64url/);
    // Validating before the round trip means a bad value can never reach Redis at all.
    expect(called).toBe(false);
  });

  it('reports a failed renewal rather than throwing', async () => {
    const broken = {
      eval: () => Promise.reject(new Error('ECONNRESET')),
      time: () => Promise.resolve([1, 0]),
    };
    await expect(renewArgon2idSlot(broken, HOLDER, { limit: 4, leaseMillis: LEASE })).resolves.toBe(
      false,
    );
  });

  it('reports a renewal of an absent holder as false, so it cannot resurrect a freed slot', async () => {
    await expect(
      renewArgon2idSlot(stub(0), HOLDER, { limit: 4, leaseMillis: LEASE }),
    ).resolves.toBe(false);
    await expect(
      renewArgon2idSlot(stub(1), HOLDER, { limit: 4, leaseMillis: LEASE }),
    ).resolves.toBe(true);
  });
});

// --- reservation refund ---------------------------------------------------------

describe('reservation refund', () => {
  const dimension = (overrides = {}) => ({
    key: deriveAbuseKey(SECRET, 'login', 'target', 'person@example.test'),
    capacity: 8,
    windowMillis: 900_000,
    commit: true,
    ...overrides,
  });

  it('returns a reservation without throwing when Redis is unavailable', async () => {
    // A lost refund must not turn an ordinary wrong password into a 503.
    const broken = { eval: () => Promise.reject(new Error('ECONNREFUSED')) };
    await expect(
      refundRateLimit(broken, [dimension()], { timeoutMillis: 100 }),
    ).resolves.toBeUndefined();
  });

  it('never manufactures budget beyond the configured capacity', async () => {
    // The clamp is in the script; this asserts the argument shape that drives it, so a regression that
    // dropped the clamp would be visible here as a missing per-dimension capacity argument.
    const calls = [];
    const recording = {
      eval: (...args) => {
        calls.push(args);
        return Promise.resolve(1);
      },
    };
    await refundRateLimit(recording, [
      dimension({ capacity: 8 }),
      dimension({ key: deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.1') }),
    ]);
    expect(calls).toHaveLength(1);
    const [, keyCount, ...rest] = calls[0];
    expect(keyCount).toBe(2);
    // Asserted by position - capacity, window, commit flag - for each key. This is the argument shape that
    // drives the script's clamp, so a regression that dropped the capacity would be visible here.
    // `rest` is the two keys followed by capacity, window, and the commit flag for each.
    expect(rest).toHaveLength(8);
    const argumentsAfterKeys = rest.slice(2);
    expect([argumentsAfterKeys[0], argumentsAfterKeys[3]]).toEqual([8, 8]);
    expect([argumentsAfterKeys[1], argumentsAfterKeys[4]]).toEqual([900_000, 900_000]);
    expect([argumentsAfterKeys[2], argumentsAfterKeys[5]]).toEqual([1, 1]);
  });

  it('refuses an empty dimension set rather than silently doing nothing', async () => {
    await expect(refundRateLimit(stub(1), [])).rejects.toThrow(/At least one rate limit dimension/);
  });
});

describe('reservation semantics after hardening', () => {
  const context = {
    clientAddress: '203.0.113.10',
    normalizedEmail: 'person@example.test',
    wellFormed: true,
  };

  it('reserves every credential dimension at admission, so concurrent requests contend', () => {
    // Stage 2.9. The global Argon2id budget and the per-account success budget are the only dimensions that are
    // checked without being charged at admission: they are charged where the work they measure happens. Every
    // credential dimension is still reserved, which is the concurrency fix this test originally pinned.
    const peekOnly = new Set([
      globalWorkloadKey(SECRET),
      deriveAbuseKey(SECRET, 'login', 'success', 'person@example.test'),
    ]);
    for (const endpoint of ['login', 'reset']) {
      const dimensions = dimensionsFor(SECRET, endpoint, context);
      expect(dimensions.length).toBeGreaterThan(0);
      const credential = dimensions.filter((dimension) => !peekOnly.has(dimension.key));
      expect(credential).toHaveLength(2);
      expect(credential.every((dimension) => dimension.commit === true)).toBe(true);
      for (const dimension of dimensions.filter((d) => peekOnly.has(d.key))) {
        expect(dimension.commit).toBe(false);
      }
    }
  });

  it('refunds only the failure-metered dimensions', () => {
    const refundable = refundableDimensionsFor(SECRET, 'login', context).map((d) => d.key);
    expect(refundable).toContain(deriveAbuseKey(SECRET, 'login', 'target', 'person@example.test'));
    expect(refundable).toContain(deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'));
    // The global verification budget measures work started and is never returned.
    expect(refundable).not.toContain(globalWorkloadKey(SECRET));

    // Request-metered endpoints have final charges; refunding them would let `forgot` stay unbounded.
    expect(refundableDimensionsFor(SECRET, 'forgot', context)).toHaveLength(0);
  });

  it('classifies exactly the outcomes that keep a charge', () => {
    // These are the guessing attempts. Everything else refunds.
    expect([...CHARGED_ERROR_CODES].sort()).toEqual([
      'AUTHENTICATION_FAILED',
      'RECOVERY_TOKEN_INVALID',
    ]);
  });

  it('still meters every request on the request-metered endpoints', () => {
    for (const endpoint of ['forgot', 'me', 'logout']) {
      expect(countsEveryRequest(endpoint)).toBe(true);
      // Source (and target, for forgot) are spent at admission. Only the global Argon2id budget, which forgot
      // consults, is check-only (Stage 2.9).
      const metered = dimensionsFor(SECRET, endpoint, context).filter(
        (d) => d.key !== globalWorkloadKey(SECRET),
      );
      expect(metered.length).toBeGreaterThan(0);
      expect(metered.every((d) => d.commit)).toBe(true);
    }
    expect(countsEveryRequest('login')).toBe(false);
    expect(countsEveryRequest('reset')).toBe(false);
  });

  it('keeps the accepted policy thresholds unchanged by the hardening', () => {
    expect(policyFor('login', 'target').capacity).toBe(8);
    expect(policyFor('login', 'source').capacity).toBe(10);
    expect(policyFor('reset', 'target').capacity).toBe(10);
    expect(policyFor('forgot', 'target').capacity).toBe(3);
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(10 ** 9)).toBe(MAX_RETRY_AFTER_SECONDS);
  });
});
