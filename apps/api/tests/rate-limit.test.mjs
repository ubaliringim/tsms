/**
 * Unit tests for the Stage 2.6 rate-limiting policy surface, key derivation, trusted client identity,
 * dimension composition, and outage classification.
 *
 * These cover the parts that must hold before any Redis is involved: what a key contains, what a
 * dimension set looks like, how an address normalises, and what each endpoint does when enforcement
 * cannot be confirmed. The atomic enforcement itself is proved in `rate-limit.integration.test.mjs`
 * against a real Redis, because a fake client cannot demonstrate atomicity.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeClientAddress,
  clientAddressOf,
  transportPeerAddress,
  UNKNOWN_CLIENT_ADDRESS,
} from '../dist/identity/client-identity.js';
import {
  AUTH_ABUSE_POLICIES,
  FAIL_CLOSED_ENDPOINTS,
  GLOBAL_ARGON2ID_BUDGET,
  MAX_RETRY_AFTER_SECONDS,
  MIN_RETRY_AFTER_SECONDS,
  deriveAbuseKey,
  globalWorkloadKey,
  metersGlobalWorkload,
  policyFor,
  retryAfterSeconds,
  VOLUME_METERED_ENDPOINTS,
  countsEveryRequest,
} from '../dist/identity/auth-abuse-policy.js';
import {
  AbuseProtectionService,
  dimensionsFor,
  refundableDimensionsFor,
} from '../dist/identity/abuse-protection.service.js';
import { RateLimitUnavailableError, RATE_LIMIT_KEY_TAG } from '@tsms/redis';

const SECRET = 'stage26_test_only_rate_limit_key_0123456789abcdef';
const OTHER_SECRET = 'stage26_test_only_rate_limit_key_fedcba9876543210';
const EMAIL = 'person@example.test';
const TOKEN = 'A'.repeat(43);

const context = (overrides = {}) => ({
  clientAddress: '203.0.113.10',
  normalizedEmail: 'person@example.test',
  recoveryToken: undefined,
  // Stage 2.9: a request the controller would accept. Malformed requests are covered in
  // auth-abuse-remediation.test.mjs.
  wellFormed: true,
  ...overrides,
});

// --- 1. Policy validation --------------------------------------------------------

describe('rate limit policy validation', () => {
  it('gives every policy a positive integer capacity and a bounded window', () => {
    for (const policy of AUTH_ABUSE_POLICIES) {
      expect(Number.isInteger(policy.capacity)).toBe(true);
      expect(policy.capacity).toBeGreaterThan(0);
      expect(Number.isInteger(policy.windowMillis)).toBe(true);
      // The Lua refill arithmetic divides by the window and multiplies by capacity; both bounds keep
      // that inside the exact-integer range Lua represents.
      expect(policy.windowMillis).toBeGreaterThanOrEqual(1_000);
      expect(policy.windowMillis).toBeLessThanOrEqual(3_600_000);
      expect(policy.capacity).toBeLessThanOrEqual(10_000);
    }
  });

  it('declares each endpoint at most once per dimension', () => {
    const seen = new Set();
    for (const policy of AUTH_ABUSE_POLICIES) {
      const key = `${policy.endpoint}/${policy.dimension}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Source is metered on all five endpoints; a gap would be an unmetered endpoint.
    for (const endpoint of ['login', 'forgot', 'reset', 'me', 'logout']) {
      expect(policyFor(endpoint, 'source')).not.toBeNull();
    }
  });

  it('meters a target dimension only where a guessing or flooding surface exists', () => {
    expect(policyFor('login', 'target')).not.toBeNull();
    expect(policyFor('forgot', 'target')).not.toBeNull();
    expect(policyFor('reset', 'target')).not.toBeNull();
    // `me` and `logout` are not a guessing surface: neither accepts an account or token to guess.
    expect(policyFor('me', 'target')).toBeNull();
    expect(policyFor('logout', 'target')).toBeNull();
  });

  it('requires enforcement on exactly the endpoints that spend Argon2id or issue a token', () => {
    expect([...FAIL_CLOSED_ENDPOINTS].sort()).toEqual(['forgot', 'login', 'reset']);
    for (const policy of AUTH_ABUSE_POLICIES) {
      expect(policy.requiresEnforcement).toBe(FAIL_CLOSED_ENDPOINTS.has(policy.endpoint));
    }
  });

  it('meters the global verification budget on every Argon2id-spending endpoint', () => {
    for (const endpoint of ['login', 'forgot', 'reset']) {
      expect(metersGlobalWorkload(endpoint)).toBe(true);
    }
    for (const endpoint of ['me', 'logout']) {
      expect(metersGlobalWorkload(endpoint)).toBe(false);
    }
    expect(GLOBAL_ARGON2ID_BUDGET.capacity).toBeGreaterThan(0);
    expect(GLOBAL_ARGON2ID_BUDGET.windowMillis).toBeGreaterThan(0);
  });

  it('binds recovery requests more tightly per target than per source', () => {
    // Recovery floods one victim's inbox, so the target meter must be the tighter of the two.
    const source = policyFor('forgot', 'source');
    const target = policyFor('forgot', 'target');
    expect(target.capacity).toBeLessThan(source.capacity);
  });

  it('keeps logout generous enough that a client cannot lock itself out', () => {
    expect(policyFor('logout', 'source').capacity).toBeGreaterThanOrEqual(30);
  });
});

// --- 2. Key derivation and 3./4. key privacy ---------------------------------------

describe('rate limit key derivation', () => {
  it('produces a key that contains no raw email address', () => {
    for (const endpoint of ['login', 'forgot']) {
      const key = deriveAbuseKey(SECRET, endpoint, 'target', EMAIL);
      expect(key).not.toContain(EMAIL);
      expect(key).not.toContain('person');
      expect(key).not.toContain('@');
      expect(key).not.toContain('example.test');
    }
  });

  it('produces a key that contains no raw recovery token', () => {
    const key = deriveAbuseKey(SECRET, 'reset', 'target', TOKEN);
    expect(key).not.toContain(TOKEN);
    expect(key).not.toContain('AAAA');
  });

  it('keys only the endpoint, dimension, and a fixed-width hex digest', () => {
    const key = deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10');
    expect(key).toMatch(new RegExp(`^\\{${RATE_LIMIT_KEY_TAG}\\}:login:source:[0-9a-f]{32}$`));
    // A fixed width keeps a key from carrying attacker-chosen length into Redis.
    expect(key.split(':').at(-1)).toHaveLength(32);
  });

  it('keeps every key in one cluster slot via a single hash tag', () => {
    const keys = [
      deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'),
      deriveAbuseKey(SECRET, 'login', 'target', EMAIL),
      deriveAbuseKey(SECRET, 'forgot', 'target', EMAIL),
      globalWorkloadKey(SECRET),
    ];
    for (const key of keys) {
      // Exactly one hash tag, and it is the shared one: a multi-key script is only slot-safe if every
      // key lands in the same slot.
      expect(key.match(/\{[^}]+\}/g)).toEqual([`{${RATE_LIMIT_KEY_TAG}}`]);
    }
  });

  it('derives unrelated keys for the same subject on different endpoints and dimensions', () => {
    const keys = new Set([
      deriveAbuseKey(SECRET, 'login', 'source', EMAIL),
      deriveAbuseKey(SECRET, 'login', 'target', EMAIL),
      deriveAbuseKey(SECRET, 'forgot', 'target', EMAIL),
      deriveAbuseKey(SECRET, 'reset', 'target', EMAIL),
    ]);
    // Cross-endpoint correlation must not be possible from key material alone.
    expect(keys.size).toBe(4);
  });

  it('derives different keys under a different secret', () => {
    // Distinct key spaces per secret are why every instance must share one secret: otherwise the
    // limit would silently become per-instance.
    expect(deriveAbuseKey(SECRET, 'login', 'target', EMAIL)).not.toBe(
      deriveAbuseKey(OTHER_SECRET, 'login', 'target', EMAIL),
    );
  });

  it('is deterministic for the same inputs, so limits persist across requests', () => {
    expect(deriveAbuseKey(SECRET, 'login', 'target', EMAIL)).toBe(
      deriveAbuseKey(SECRET, 'login', 'target', EMAIL),
    );
  });

  it('gives the global workload one key regardless of subject', () => {
    expect(globalWorkloadKey(SECRET)).toBe(globalWorkloadKey(SECRET));
    expect(globalWorkloadKey(SECRET)).not.toBe(globalWorkloadKey(OTHER_SECRET));
  });

  it('refuses an empty subject rather than skipping the meter', () => {
    expect(() => deriveAbuseKey(SECRET, 'login', 'target', '')).toThrow();
  });

  it('rejects a key component that could alter the key structure', () => {
    for (const component of ['login:x', 'LOGIN', 'a'.repeat(33), 'a:b:c']) {
      expect(() => deriveAbuseKey(SECRET, component, 'source', 'x')).toThrow();
      expect(() => deriveAbuseKey(SECRET, 'login', component, 'x')).toThrow();
    }
  });

  it('bounds an oversized subject instead of rejecting it', () => {
    // Rejecting on length would make response timing depend on subject length; truncating keeps
    // hashing cost constant and still produces a stable key.
    const huge = 'a'.repeat(5_000);
    const key = deriveAbuseKey(SECRET, 'login', 'target', huge);
    expect(key).toBe(deriveAbuseKey(SECRET, 'login', 'target', 'a'.repeat(512)));
    expect(key.split(':').at(-1)).toMatch(/^[0-9a-f]{32}$/);
    // A different oversize subject still lands on its own bucket.
    expect(deriveAbuseKey(SECRET, 'login', 'target', 'b'.repeat(5_000))).not.toBe(key);
  });
});

// --- 5./6./7. client address normalisation -----------------------------------------

describe('trusted client address normalisation', () => {
  it('accepts a dotted-quad IPv4 address', () => {
    expect(normalizeClientAddress('203.0.113.10')).toBe('203.0.113.10');
  });

  it('normalises every spelling of one IPv6 address to the same form', () => {
    const spellings = [
      '2001:db8::1',
      '2001:DB8::1',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
      '2001:db8:0:0:0:0:0:1',
    ];
    const canonical = new Set(spellings.map((value) => normalizeClientAddress(value)));
    expect(canonical.size).toBe(1);
    expect([...canonical][0]).toBe('2001:db8::1');
  });

  it('collapses an IPv4-mapped IPv6 address onto the IPv4 address it embeds', () => {
    // A dual-stack socket reports an IPv4 client this way. Treating the two notations as different
    // identities would hand one client two independent buckets.
    expect(normalizeClientAddress('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeClientAddress('::FFFF:203.0.113.10')).toBe('203.0.113.10');
    expect(normalizeClientAddress('::203.0.113.10')).toBe('203.0.113.10');
  });

  it('gives one bucket to every notation of the same client', () => {
    // Normalisation happens before hashing, so it is the normaliser that has to collapse the
    // notations. Hashing the raw text would correctly give different keys; what must not happen is
    // an un-normalised address reaching the hash in the request path.
    const forms = ['203.0.113.10', '::ffff:203.0.113.10', '::FFFF:203.0.113.10', '::203.0.113.10'];
    const normalized = forms.map((value) => normalizeClientAddress(value));
    expect(new Set(normalized).size).toBe(1);
    const keys = new Set(
      normalized.map((value) => deriveAbuseKey(SECRET, 'login', 'source', value)),
    );
    expect(keys.size).toBe(1);
    expect(keys.has(deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'))).toBe(true);
  });

  it('keeps the unspecified IPv6 address distinct from an IPv4-mapped one', () => {
    // `::` is a genuine unspecified IPv6 address; `::ffff:0.0.0.0` is the mapped form of 0.0.0.0.
    expect(normalizeClientAddress('::')).toBe('::');
    expect(normalizeClientAddress('::ffff:0.0.0.0')).toBe('0.0.0.0');
  });

  it('keeps distinct clients on distinct addresses', () => {
    expect(normalizeClientAddress('203.0.113.10')).not.toBe(normalizeClientAddress('203.0.113.11'));
    expect(normalizeClientAddress('2001:db8::1')).not.toBe(normalizeClientAddress('2001:db8::2'));
  });

  it('rejects a scoped address, which identifies an interface rather than a host', () => {
    expect(normalizeClientAddress('fe80::1%eth0')).toBeNull();
  });

  it('rejects anything that is not an address, rather than keying on raw input', () => {
    for (const value of [
      '',
      'not-an-address',
      '999.0.0.1',
      '1.2.3',
      '2001:db8:::1',
      null,
      42,
      {},
    ]) {
      expect(normalizeClientAddress(value)).toBeNull();
    }
  });

  it('rejects an over-long input before it can become a key component', () => {
    expect(normalizeClientAddress('a'.repeat(65))).toBeNull();
  });

  it('strips brackets some stacks add around an IPv6 literal', () => {
    expect(normalizeClientAddress('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('does not silently trim whitespace into a different address', () => {
    expect(normalizeClientAddress(' 203.0.113.10')).toBeNull();
  });
});

// --- 8. transport peer and untrusted headers -------------------------------------

describe('transport peer as the trusted client identity', () => {
  it('reads the address from the socket', () => {
    expect(transportPeerAddress({ socket: { remoteAddress: '203.0.113.10' } })).toBe(
      '203.0.113.10',
    );
  });

  it('produces the same bucket for every forwarding header an attacker might send', () => {
    // The request object below carries the full set of headers used to influence client identity.
    // None of them is read, so none of them can mint a fresh identity.
    const withSpoofedHeaders = {
      socket: { remoteAddress: '203.0.113.10' },
      headers: {
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
        forwarded: 'for=198.51.100.3',
        'cf-connecting-ip': '198.51.100.4',
        'true-client-ip': '198.51.100.5',
        'x-client-ip': '198.51.100.6',
        'forwarded-for': '198.51.100.7',
        'x-original-forwarded-for': '198.51.100.8',
      },
      ip: '198.51.100.9',
      hostname: '198.51.100.10',
    };
    const honest = { socket: { remoteAddress: '203.0.113.10' } };
    const key = (request) => deriveAbuseKey(SECRET, 'login', 'source', clientAddressOf(request));
    expect(key(withSpoofedHeaders)).toBe(key(honest));
    expect(key(withSpoofedHeaders)).toBe(deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'));
  });

  it('collapses an unusable peer address into one shared bucket', () => {
    for (const request of [{}, { socket: {} }, { socket: { remoteAddress: undefined } }, null]) {
      expect(clientAddressOf(request)).toBe(UNKNOWN_CLIENT_ADDRESS);
    }
    // The shared bucket is stricter, not looser: an unidentified caller cannot gain capacity.
    expect(clientAddressOf({ socket: { remoteAddress: 'garbage' } })).toBe(UNKNOWN_CLIENT_ADDRESS);
  });
});

// --- 11. Retry-After bounds ------------------------------------------------------

describe('Retry-After bounds', () => {
  it('rounds up so a retry never lands a millisecond early', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(1_000)).toBe(1);
  });

  it('never returns less than one second', () => {
    expect(retryAfterSeconds(0)).toBe(MIN_RETRY_AFTER_SECONDS);
    expect(retryAfterSeconds(-5)).toBe(MIN_RETRY_AFTER_SECONDS);
    expect(retryAfterSeconds(Number.NaN)).toBe(MIN_RETRY_AFTER_SECONDS);
  });

  it('clamps to a bounded maximum so a client cannot park on a long hint', () => {
    expect(retryAfterSeconds(3_600_000)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(retryAfterSeconds(86_400_000)).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('always returns a whole number of seconds', () => {
    for (const value of [0, 1, 999, 1_500, 60_000, 10 ** 9]) {
      expect(Number.isInteger(retryAfterSeconds(value))).toBe(true);
    }
  });
});

// --- 13. dimension composition ---------------------------------------------------

describe('dimension composition', () => {
  it('consults login on source, account, the global verification budget, and the account success budget', () => {
    const keys = dimensionsFor(SECRET, 'login', context()).map((dimension) => dimension.key);
    expect(keys).toHaveLength(4);
    expect(keys).toContain(deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'));
    expect(keys).toContain(deriveAbuseKey(SECRET, 'login', 'target', EMAIL));
    expect(keys).toContain(globalWorkloadKey(SECRET));
    expect(keys).toContain(deriveAbuseKey(SECRET, 'login', 'success', EMAIL));
  });

  it('reserves every credential meter at admission so concurrent requests contend', () => {
    const preFlight = dimensionsFor(SECRET, 'login', context());
    const sourceKey = deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10');

    // Stage 2.6 hardening. Admission reserves rather than merely inspecting: a check that writes nothing
    // lets every simultaneous request read the same untouched bucket, which is the concurrency bypass the
    // review found.
    expect(preFlight.find((d) => d.key === sourceKey).commit).toBe(true);
    const targetKey = deriveAbuseKey(SECRET, 'login', 'target', EMAIL);
    expect(preFlight.find((d) => d.key === targetKey).commit).toBe(true);
    // Stage 2.9. The global verification budget and the per-account success budget are only CHECKED at
    // admission. They are charged where the work they measure actually happens, so a request that never
    // reaches Argon2id or never authenticates spends neither.
    expect(preFlight.find((d) => d.key === globalWorkloadKey(SECRET)).commit).toBe(false);
    const successKey = deriveAbuseKey(SECRET, 'login', 'success', EMAIL);
    expect(preFlight.find((d) => d.key === successKey).commit).toBe(false);
  });

  it('refunds the credential reservation for an attempt that was not abuse', () => {
    const refundable = refundableDimensionsFor(SECRET, 'login', context()).map((d) => d.key);
    const sourceKey = deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10');

    // This is what makes "a legitimate success is free" an enforced property rather than an intention:
    // the reservation is returned whenever the outcome was not a credential failure.
    expect(refundable).toContain(sourceKey);
    // The global budget measures work started, so it is never returned.
    expect(refundable).not.toContain(globalWorkloadKey(SECRET));
  });

  it('meters password recovery by request, because a flooding request succeeds', () => {
    // A failure-metered forgot would limit nothing: flooding works precisely because each request
    // answers 202. Its source and target meters must therefore be spent at admission. The global Argon2id
    // budget is only checked (Stage 2.9): an eligible request performs no Argon2id.
    const preFlight = dimensionsFor(SECRET, 'forgot', context());
    const credential = preFlight.filter((d) => d.key !== globalWorkloadKey(SECRET));
    expect(credential).toHaveLength(2);
    expect(credential.every((dimension) => dimension.commit)).toBe(true);
    expect(preFlight.find((d) => d.key === globalWorkloadKey(SECRET)).commit).toBe(false);
    // And its charges are final: refunding them would let an attacker keep issuing unboundedly by
    // interleaving requests whose outcomes are not credential failures.
    expect(refundableDimensionsFor(SECRET, 'forgot', context())).toHaveLength(0);
  });

  it('meters me and logout by request volume', () => {
    for (const endpoint of ['me', 'logout']) {
      expect(dimensionsFor(SECRET, endpoint, context()).every((d) => d.commit)).toBe(true);
      expect(refundableDimensionsFor(SECRET, endpoint, context())).toHaveLength(0);
    }
  });

  it('refunds the reset reservation without returning the global budget', () => {
    const refundable = refundableDimensionsFor(SECRET, 'reset', context({ recoveryToken: TOKEN }));
    expect(refundable).toHaveLength(2);
    expect(refundable.every((dimension) => dimension.commit)).toBe(true);
    // Work started is work done; returning the verification budget would undo the bound on Argon2id.
    expect(refundable.map((d) => d.key)).not.toContain(globalWorkloadKey(SECRET));
  });

  it('classifies every endpoint as request-metered or failure-metered unambiguously', () => {
    expect([...VOLUME_METERED_ENDPOINTS].sort()).toEqual(['forgot', 'logout', 'me']);
    for (const endpoint of ['login', 'reset']) {
      expect(countsEveryRequest(endpoint)).toBe(false);
    }
  });

  it('charges recovery on source and target, with a tighter target meter', () => {
    const dimensions = dimensionsFor(SECRET, 'forgot', context());
    expect(dimensions).toHaveLength(3);
    const source = dimensions.find(
      (d) => d.key === deriveAbuseKey(SECRET, 'forgot', 'source', '203.0.113.10'),
    );
    const target = dimensions.find(
      (d) => d.key === deriveAbuseKey(SECRET, 'forgot', 'target', EMAIL),
    );
    expect(target.capacity).toBeLessThan(source.capacity);
  });

  it('charges reset on source, token, and the global budget', () => {
    const dimensions = dimensionsFor(SECRET, 'reset', context({ recoveryToken: TOKEN }));
    expect(dimensions).toHaveLength(3);
    expect(dimensions.map((d) => d.key)).toContain(globalWorkloadKey(SECRET));
  });

  it('charges me and logout on source only, with no verification budget', () => {
    for (const endpoint of ['me', 'logout']) {
      const dimensions = dimensionsFor(SECRET, endpoint, context());
      expect(dimensions).toHaveLength(1);
      expect(dimensions[0].key).toBe(deriveAbuseKey(SECRET, endpoint, 'source', '203.0.113.10'));
      expect(dimensions.map((d) => d.key)).not.toContain(globalWorkloadKey(SECRET));
    }
  });

  it('carries no duplicate key, since a duplicate would charge one bucket twice', () => {
    for (const endpoint of ['login', 'forgot', 'reset', 'me', 'logout']) {
      const keys = dimensionsFor(SECRET, endpoint, context({ recoveryToken: TOKEN })).map(
        (d) => d.key,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('skips the account dimension when there is no usable address', () => {
    // A malformed address cannot be normalised, so it must not silently become an unmetered path.
    const dimensions = dimensionsFor(SECRET, 'login', context({ normalizedEmail: null }));
    const targetPrefix = `{${RATE_LIMIT_KEY_TAG}}:login:target:`;
    expect(dimensions.filter((d) => d.key.startsWith(targetPrefix))).toHaveLength(0);
    // Source and the global budget remain, so the request is still metered.
    expect(dimensions).toHaveLength(2);
    expect(dimensions.map((d) => d.key)).toContain(
      deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'),
    );
  });

  it('meters a malformed recovery token on a stable shared subject', () => {
    const first = dimensionsFor(SECRET, 'reset', context({ recoveryToken: 'not-a-token' }));
    const second = dimensionsFor(SECRET, 'reset', context({ recoveryToken: undefined }));
    const targetOf = (dimensions) =>
      dimensions
        .map((d) => d.key)
        .find((key) => key.startsWith(`{${RATE_LIMIT_KEY_TAG}}:reset:target:`));
    // Guessing attempts on unusable tokens are metered rather than falling through.
    expect(targetOf(first)).toBe(targetOf(second));
  });

  it('gives two accounts on one source independent target budgets', () => {
    const first = dimensionsFor(SECRET, 'login', context({ normalizedEmail: 'a@example.test' }));
    const second = dimensionsFor(SECRET, 'login', context({ normalizedEmail: 'b@example.test' }));
    const source = (dimensions) =>
      dimensions
        .map((d) => d.key)
        .find((key) => key.startsWith(`{${RATE_LIMIT_KEY_TAG}}:login:source:`));
    const target = (dimensions) =>
      dimensions
        .map((d) => d.key)
        .find((key) => key.startsWith(`{${RATE_LIMIT_KEY_TAG}}:login:target:`));
    expect(target(first)).not.toBe(target(second));
    // Cross-user isolation: exhausting one account must not consume another's budget.
    expect(source(first)).toBe(source(second));
  });
});

// --- 14./15./16. Redis failure and outage classification ---------------------------

/** A client whose every command fails, standing in for Redis being unavailable. */
const brokenRedis = (failure) => ({ eval: () => Promise.reject(failure) });

/** A client that resolves a reply the limiter must not act on. */
const replyingRedis = (reply) => ({ eval: () => Promise.resolve(reply) });

describe('Redis failure handling', () => {
  const unavailable = new RateLimitUnavailableError('redis');

  it('fails closed on every endpoint that spends Argon2id or issues a token', async () => {
    for (const endpoint of ['login', 'forgot', 'reset']) {
      const service = new AbuseProtectionService({
        secret: SECRET,
        redis: brokenRedis(unavailable),
      });
      const decision = await service.decide(endpoint, context({ recoveryToken: TOKEN }));
      expect(decision.kind).toBe('unavailable');
      expect(decision.proceeds).toBe(false);
    }
  });

  it('proceeds on me and logout, whose revocation does not depend on Redis', async () => {
    for (const endpoint of ['me', 'logout']) {
      const service = new AbuseProtectionService({
        secret: SECRET,
        redis: brokenRedis(unavailable),
      });
      const decision = await service.decide(endpoint, context());
      expect(decision.kind).toBe('unavailable');
      expect(decision.proceeds).toBe(true);
    }
  });

  it('never falls back to allowing traffic when Redis is unreachable', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: brokenRedis(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    });
    const decision = await service.decide('login', context());
    expect(decision.proceeds).toBe(false);
  });

  it('treats a timeout as unconfirmable rather than as a limit decision', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: brokenRedis(new RateLimitUnavailableError('timeout')),
      timeoutMillis: 50,
    });
    const decision = await service.decide('login', context());
    expect(decision.kind).toBe('unavailable');
    expect(decision.proceeds).toBe(false);
  });

  it('refuses to act on a malformed reply', async () => {
    for (const reply of [
      [],
      [1],
      [1, 0, 0],
      ['1', '0'],
      [2, 0],
      [1, -1],
      [0, 'soon'],
      null,
      'OK',
    ]) {
      const service = new AbuseProtectionService({ secret: SECRET, redis: replyingRedis(reply) });
      const decision = await service.decide('login', context());
      // A reply the code does not recognise is not permission to serve.
      expect(decision.kind).toBe('unavailable');
      expect(decision.proceeds).toBe(false);
    }
  });

  it('rethrows an unexpected error instead of swallowing it as an outage', async () => {
    // A configuration or programming fault is not an operational Redis problem, and hiding it would
    // leave a real defect invisible in production.
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: { eval: () => Promise.resolve([1, 0]) },
    });
    await expect(service.decide('login', context())).resolves.toMatchObject({ kind: 'allowed' });
  });

  it('reports a declined meter as limited, never as unavailable', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: replyingRedis([0, 1_500]),
    });
    const decision = await service.decide('login', context());
    expect(decision.kind).toBe('limited');
    expect(decision.proceeds).toBe(false);
    expect(decision.retryAfterSeconds).toBe(2);
  });

  it('reports an admitted request as allowed on every endpoint', async () => {
    for (const endpoint of ['login', 'forgot', 'reset', 'me', 'logout']) {
      const service = new AbuseProtectionService({
        secret: SECRET,
        redis: replyingRedis([1, 0]),
      });
      const decision = await service.decide(endpoint, context({ recoveryToken: TOKEN }));
      // Stage 2.9: `reserved` is true only where a failure-metered credential reservation was taken, because
      // that is the only case in which a refund is owed.
      expect(decision).toEqual({
        kind: 'allowed',
        reserved: endpoint === 'login' || endpoint === 'reset',
        retryAfterSeconds: 0,
        proceeds: true,
      });
    }
  });

  it('issues exactly one Redis command per decision, carrying every dimension', async () => {
    const calls = [];
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: {
        eval: (...args) => {
          calls.push(args);
          return Promise.resolve([1, 0]);
        },
      },
    });
    await service.decide('login', context());
    // One script invocation means all dimensions are decided in one atomic step.
    expect(calls).toHaveLength(1);
    const [script, keyCount, ...rest] = calls[0];
    expect(script).toContain('HMGET');
    expect(keyCount).toBe(4);
    expect(rest.slice(0, 4).every((key) => key.startsWith(`{${RATE_LIMIT_KEY_TAG}}:`))).toBe(true);
    // Four keys, then capacity, window, and the commit flag for each: 4 + 4 * 3.
    expect(rest).toHaveLength(16);
  });
});

// --- failure charging ------------------------------------------------------------

describe('reservation refunding', () => {
  /** A recording client that admits everything. */
  const admittingRedis = (calls) => ({
    eval: (...args) => {
      calls.push(args);
      return Promise.resolve([1, 0]);
    },
  });

  it('returns both credential reservations in one script call', async () => {
    const calls = [];
    const service = new AbuseProtectionService({ secret: SECRET, redis: admittingRedis(calls) });
    await service.refundFor('login', context());
    expect(calls).toHaveLength(1);
    const [, keyCount, ...rest] = calls[0];
    expect(keyCount).toBe(2);
    expect(rest.slice(0, 2)).toEqual([
      deriveAbuseKey(SECRET, 'login', 'source', '203.0.113.10'),
      deriveAbuseKey(SECRET, 'login', 'target', EMAIL),
    ]);
  });

  it('returns nothing for an endpoint whose charges are final', async () => {
    for (const endpoint of ['forgot', 'me', 'logout']) {
      const calls = [];
      const service = new AbuseProtectionService({ secret: SECRET, redis: admittingRedis(calls) });
      await service.refundFor(endpoint, context());
      // These meters measure request volume. Refunding them would undo the control entirely.
      expect(calls).toHaveLength(0);
    }
  });

  it('swallows a Redis failure so a lost refund cannot change the response', async () => {
    const service = new AbuseProtectionService({
      secret: SECRET,
      redis: brokenRedis(new Error('ECONNRESET')),
    });
    // The response has already been produced. A lost refund costs this caller one unit of its own
    // allowance; surfacing it would turn an ordinary wrong password into a 503.
    await expect(service.refundFor('login', context())).resolves.toBeUndefined();
  });
});
