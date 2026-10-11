/**
 * Rate limiting against a real Redis - Stage 2.6.
 *
 * A fake client cannot demonstrate the property that matters most here: that concurrent requests
 * cannot exceed the configured allowance. That claim is only meaningful against a real server
 * executing the script, so these tests use the guarded non-default logical database and drive genuine
 * concurrent traffic at a limit boundary.
 *
 * No test sleeps to wait out a window. Buckets are given real Redis time where a refill has to be
 * observed, and every wait is bounded and polled, so a slow machine makes a test slower rather than
 * flaky.
 */

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { assertDisposableTestRedis } from '@tsms/redis/testing';
import { closeRedis, createRedisClient, pingRedis } from '../dist/client.js';
import {
  consumeRateLimit,
  RateLimitUnavailableError,
  RATE_LIMIT_KEY_TAG,
} from '../dist/rate-limit.js';

/** Short windows keep the suite quick while remaining real buckets, not injected clocks. */
const WINDOW = 5_000;

let real;
let owned;

/**
 * A key in the one namespace the limiter accepts.
 *
 * Each subject is unique per test, so tests never share a bucket and never need to clean up after
 * one another.
 */
/**
 * A key in the one namespace the limiter accepts.
 *
 * The subject is hashed so the key is the right shape regardless of what it contains, and the
 * namespace is unique per call so no two tests can ever share a bucket.
 */
const testKey = (subject) =>
  `{${RATE_LIMIT_KEY_TAG}}:login:source:${createHash('sha256')
    .update(subject)
    .update(randomUUID())
    .digest('hex')
    .slice(0, 32)}`;

/** Poll until `check` is true or the budget expires. Never sleeps for a fixed duration. */
async function eventually(check, { timeoutMillis = 15_000, intervalMillis = 25 } = {}) {
  const deadline = Date.now() + timeoutMillis;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not reached within its budget');
    await new Promise((done) => setTimeout(done, intervalMillis));
  }
}

/** A Redis client pointed at a closed loopback port, standing in for an outage. */
function unreachableClient() {
  return createRedisClient('redis://:unused@127.0.0.1:6399/1', { connectTimeoutMillis: 1_000 });
}

beforeAll(async () => {
  const integration = parseIntegrationEnvironment(process.env);
  const url = assertDisposableTestRedis(integration.TEST_REDIS_URL);
  real = createRedisClient(url);
  await pingRedis(real, { timeoutMillis: 5_000 });
});

afterAll(async () => {
  if (owned) await closeRedis(owned);
  if (real) await closeRedis(real);
});

// --- 9. atomic counter behaviour -------------------------------------------------

describe('atomic token bucket', () => {
  it('admits exactly the configured capacity, then refuses', async () => {
    const key = testKey('capacity');
    const dimension = { key, capacity: 3, windowMillis: WINDOW, commit: true };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const verdict = await consumeRateLimit(real, [dimension]);
      expect(verdict.allowed).toBe(true);
      expect(verdict.retryAfterMillis).toBe(0);
    }

    const refused = await consumeRateLimit(real, [dimension]);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMillis).toBeGreaterThan(0);
  });

  it('cannot be exceeded by concurrent requests at the limit boundary', async () => {
    // The central guarantee. Twenty requests race for five slots against a real server; exactly five
    // must be admitted. A non-atomic check-then-increment would let more through.
    const key = testKey('boundary');
    const dimension = { key, capacity: 5, windowMillis: WINDOW, commit: true };
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(real, [dimension])),
    );
    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(5);
    expect(verdicts.filter((verdict) => !verdict.allowed)).toHaveLength(15);
  });

  it('charges every dimension atomically, admitting only when all have capacity', async () => {
    const first = { key: testKey('multi-a'), capacity: 10, windowMillis: WINDOW, commit: true };
    const second = { key: testKey('multi-b'), capacity: 10, windowMillis: WINDOW, commit: true };
    const third = { key: testKey('multi-c'), capacity: 10, windowMillis: WINDOW, commit: true };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await consumeRateLimit(real, [first, second, third])).allowed).toBe(true);
    }

    // All three are empty now, so the eleventh is refused by all three.
    const verdict = await consumeRateLimit(real, [first, second, third]);
    expect(verdict.allowed).toBe(false);
    // Every exhausted dimension shares one wait, and the longest is reported.
    const retries = await Promise.all([
      consumeRateLimit(real, [first]),
      consumeRateLimit(real, [second]),
      consumeRateLimit(real, [third]),
    ]);
    expect(verdict.retryAfterMillis).toBeGreaterThan(0);
    expect(Math.max(...retries.map((entry) => entry.retryAfterMillis))).toBeGreaterThan(0);
  });

  it('writes nothing when one dimension refuses, so a denial cannot drain another dimension', async () => {
    // The all-or-nothing rule. A fresh, generous dimension must not be charged by a request that a
    // different dimension rejected, otherwise an attacker could exhaust an unrelated budget.
    // A long window keeps refill out of the picture, so the only thing that can move these counts is
    // whether the script wrote.
    const exhausted = {
      key: testKey('exhausted'),
      capacity: 1,
      windowMillis: 60_000,
      commit: true,
    };
    const untouched = {
      key: testKey('untouched'),
      capacity: 10,
      windowMillis: 60_000,
      commit: true,
    };

    expect((await consumeRateLimit(real, [exhausted, untouched])).allowed).toBe(true);
    expect((await consumeRateLimit(real, [exhausted, untouched])).allowed).toBe(false);

    // The refused call wrote nothing, so the untouched dimension has exactly nine charges left.
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      expect((await consumeRateLimit(real, [untouched])).allowed).toBe(true);
    }
    expect((await consumeRateLimit(real, [untouched])).allowed).toBe(false);
  });

  it('keeps two subjects on one bucket independent', async () => {
    const first = { key: testKey('isolation-a'), capacity: 2, windowMillis: WINDOW, commit: true };
    const second = { key: testKey('isolation-b'), capacity: 2, windowMillis: WINDOW, commit: true };

    expect((await consumeRateLimit(real, [first])).allowed).toBe(true);
    expect((await consumeRateLimit(real, [first])).allowed).toBe(true);
    expect((await consumeRateLimit(real, [first])).allowed).toBe(false);
    // Exhausting one subject must not affect another: this is cross-user isolation.
    expect((await consumeRateLimit(real, [second])).allowed).toBe(true);
  });

  it('refuses duplicate dimensions rather than charging one bucket twice', async () => {
    const key = testKey('duplicate');
    const dimension = { key, capacity: 5, windowMillis: WINDOW, commit: true };
    await expect(consumeRateLimit(real, [dimension, dimension])).rejects.toThrow(/distinct keys/);
  });
});

// --- 10. expiry behaviour --------------------------------------------------------

describe('expiry', () => {
  it('sets a TTL on first write, so a key cannot outlive its window', async () => {
    const key = testKey('ttl');
    await consumeRateLimit(real, [{ key, capacity: 10, windowMillis: WINDOW, commit: true }]);
    const ttl = await real.pttl(key);
    // Never no-expiry, and never longer than the window that defines the bucket.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WINDOW);
  });

  it('refills the bucket as its window elapses', async () => {
    const key = testKey('refill');
    const dimension = { key, capacity: 1, windowMillis: 1_000, commit: true };

    expect((await consumeRateLimit(real, [dimension])).allowed).toBe(true);
    expect((await consumeRateLimit(real, [dimension])).allowed).toBe(false);

    // One token per one-second window, so a slot reappears without any explicit reset.
    await eventually(async () => (await consumeRateLimit(real, [dimension])).allowed, {
      timeoutMillis: 10_000,
    });
  });

  it('lets an expired key disappear rather than accumulating', async () => {
    const key = testKey('evicted');
    await consumeRateLimit(real, [{ key, capacity: 1, windowMillis: 1_000, commit: true }]);
    expect(await real.exists(key)).toBe(1);
    // Poll for actual removal: a lingering key would be unbounded growth.
    await eventually(async () => (await real.exists(key)) === 0, { timeoutMillis: 15_000 });
  });

  it('leaves no keys behind for subjects that were never admitted', async () => {
    const key = testKey('never-admitted');
    const verdict = await consumeRateLimit(real, [
      { key, capacity: 1, windowMillis: WINDOW, commit: true },
    ]);
    expect(verdict.allowed).toBe(true);
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 1, windowMillis: WINDOW, commit: true }]))
        .allowed,
    ).toBe(false);
    expect(await real.exists(key)).toBe(1);
  });
});

// --- 11. retry calculation -------------------------------------------------------

describe('retry calculation', () => {
  it('reports a wait proportional to the remaining window', async () => {
    const key = testKey('retry');
    const dimension = { key, capacity: 1, windowMillis: 4_000, commit: true };
    await consumeRateLimit(real, [dimension]);
    const verdict = await consumeRateLimit(real, [dimension]);

    expect(verdict.allowed).toBe(false);
    // A one-token bucket is empty immediately, so the wait approaches the whole window and never
    // exceeds it.
    expect(verdict.retryAfterMillis).toBeGreaterThan(2_000);
    expect(verdict.retryAfterMillis).toBeLessThanOrEqual(4_000);
  });

  it('shrinks the wait as the bucket refills', async () => {
    const key = testKey('shrinking');
    const dimension = { key, capacity: 1, windowMillis: 2_000, commit: true };
    await consumeRateLimit(real, [dimension]);

    const first = await consumeRateLimit(real, [dimension]);
    await new Promise((done) => setTimeout(done, 1_000));
    const second = await consumeRateLimit(real, [dimension]);

    expect(second.retryAfterMillis).toBeLessThan(first.retryAfterMillis);
  });

  it('reports zero wait for an admitted request', async () => {
    const key = testKey('zero-wait');
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 5, windowMillis: WINDOW, commit: true }]))
        .retryAfterMillis,
    ).toBe(0);
  });
});

// --- 14./15. failure handling ----------------------------------------------------

describe('Redis failure handling', () => {
  it('reports an unreachable Redis as unavailable rather than admitting traffic', async () => {
    owned = unreachableClient();
    try {
      await expect(
        consumeRateLimit(
          owned,
          [{ key: testKey('outage'), capacity: 5, windowMillis: WINDOW, commit: true }],
          {
            timeoutMillis: 2_000,
          },
        ),
      ).rejects.toBeInstanceOf(RateLimitUnavailableError);
    } finally {
      await closeRedis(owned);
      owned = undefined;
    }
  });

  it('bounds a hanging Redis with a timeout', async () => {
    // A client whose command never settles stands in for a stalled server. Without the bound the
    // request would hang instead of failing closed.
    const stalled = { eval: () => new Promise(() => {}) };
    const started = Date.now();
    await expect(
      consumeRateLimit(
        stalled,
        [{ key: testKey('stall'), capacity: 5, windowMillis: WINDOW, commit: true }],
        {
          timeoutMillis: 250,
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a malformed reply rather than coercing it', async () => {
    for (const reply of [
      null,
      undefined,
      'OK',
      [],
      [1],
      [1, 0, 0],
      ['1', '0'],
      [2, 0],
      [-1, 0],
      [1, -1],
      [1, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [{ allowed: true }, 0],
    ]) {
      const client = { eval: () => Promise.resolve(reply) };
      await expect(
        consumeRateLimit(client, [
          { key: testKey('malformed'), capacity: 5, windowMillis: WINDOW, commit: true },
        ]),
      ).rejects.toBeInstanceOf(RateLimitUnavailableError);
    }
  });

  it('accepts exactly the two verdict shapes the script produces', async () => {
    const allowed = { eval: () => Promise.resolve([1, 0]) };
    await expect(
      consumeRateLimit(allowed, [
        { key: testKey('ok'), capacity: 5, windowMillis: WINDOW, commit: true },
      ]),
    ).resolves.toEqual({ allowed: true, retryAfterMillis: 0 });

    const refused = { eval: () => Promise.resolve([0, 1_234]) };
    await expect(
      consumeRateLimit(refused, [
        { key: testKey('no'), capacity: 5, windowMillis: WINDOW, commit: true },
      ]),
    ).resolves.toEqual({ allowed: false, retryAfterMillis: 1_234 });
  });

  it('never leaks a connection detail through the error it raises', async () => {
    const client = {
      eval: () =>
        Promise.reject(new Error('READONLY auth failed for user app:sup3rs3cret@10.0.0.5')),
    };
    const failure = await consumeRateLimit(client, [
      { key: testKey('secret'), capacity: 5, windowMillis: WINDOW, commit: true },
    ]).catch((error) => error);
    expect(failure).toBeInstanceOf(RateLimitUnavailableError);
    // The driver message could carry the Redis password, so it is discarded rather than wrapped.
    expect(failure.message).not.toContain('sup3rs3cret');
    expect(failure.message).not.toContain('10.0.0.5');
  });

  it('recovers and enforces normally once Redis is reachable again', async () => {
    const key = testKey('recovery');
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 2, windowMillis: WINDOW, commit: true }]))
        .allowed,
    ).toBe(true);
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 2, windowMillis: WINDOW, commit: true }]))
        .allowed,
    ).toBe(true);
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 2, windowMillis: WINDOW, commit: true }]))
        .allowed,
    ).toBe(false);
  });
});

// --- configuration validation ----------------------------------------------------

describe('configuration validation', () => {
  const key = testKey('config');

  it('rejects a malformed key that could alter the key namespace', async () => {
    for (const bad of [
      '',
      'no-hash-tag:login:source:' + 'a'.repeat(32),
      `{${RATE_LIMIT_KEY_TAG}}:LOGIN:source:${'a'.repeat(32)}`,
      `{other}:login:source:${'a'.repeat(32)}`,
    ]) {
      await expect(
        consumeRateLimit(real, [{ key: bad, capacity: 5, windowMillis: WINDOW, commit: true }]),
      ).rejects.toThrow(/malformed key/);
    }
  });

  it('rejects a non-positive or fractional capacity', async () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      await expect(
        consumeRateLimit(real, [{ key, capacity, windowMillis: WINDOW }]),
      ).rejects.toThrow(/capacity/);
    }
  });

  it('rejects an unbounded or zero window', async () => {
    for (const windowMillis of [0, -1, 999, 3_600_001, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(consumeRateLimit(real, [{ key, capacity: 5, windowMillis }])).rejects.toThrow(
        /window/,
      );
    }
  });

  it('rejects a capacity too large to refill exactly in the script', async () => {
    await expect(
      consumeRateLimit(real, [{ key, capacity: 10_001, windowMillis: WINDOW, commit: true }]),
    ).rejects.toThrow(/capacity/);
  });
});

// --- check-only dimensions -------------------------------------------------------

describe('check without charge', () => {
  it('evaluates a commit:false dimension without consuming budget', async () => {
    const key = testKey('check-only');
    const peek = { key, capacity: 3, windowMillis: 60_000, commit: false };
    const spend = { key, capacity: 3, windowMillis: 60_000, commit: true };

    // Repeatedly asking must be free, or a caller could drain a budget merely by checking.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await consumeRateLimit(real, [peek])).allowed).toBe(true);
    }

    // The full allowance is still available, so nothing was spent by asking.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await consumeRateLimit(real, [spend])).allowed).toBe(true);
    }
    expect((await consumeRateLimit(real, [spend])).allowed).toBe(false);
  });

  it('reports a wait for a commit:false dimension without spending it', async () => {
    const key = testKey('check-refused');
    const spend = { key, capacity: 1, windowMillis: 60_000, commit: true };
    const peek = { key, capacity: 1, windowMillis: 60_000, commit: false };

    expect((await consumeRateLimit(real, [spend])).allowed).toBe(true);
    const refused = await consumeRateLimit(real, [peek]);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMillis).toBeGreaterThan(0);
  });

  it('still refuses a mixed set when only one dimension is exhausted', async () => {
    const exhausted = {
      key: testKey('mixed-exhausted'),
      capacity: 1,
      windowMillis: 60_000,
      commit: true,
    };
    const generous = {
      key: testKey('mixed-generous'),
      capacity: 50,
      windowMillis: 60_000,
      commit: false,
    };
    const generousSpend = { ...generous, commit: true };

    expect((await consumeRateLimit(real, [exhausted, generous])).allowed).toBe(true);
    // The check-only dimension is fine, but the other is empty, so the whole request is refused.
    expect((await consumeRateLimit(real, [exhausted, generous])).allowed).toBe(false);
    // And the check-only dimension was not charged by either refusal.
    let admitted = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await consumeRateLimit(real, [generousSpend])).allowed) admitted += 1;
    }
    expect(admitted).toBe(50);
  });

  it('creates no key for a check on a subject that has never been charged', async () => {
    const key = testKey('check-no-key');
    expect(
      (await consumeRateLimit(real, [{ key, capacity: 5, windowMillis: 60_000, commit: false }]))
        .allowed,
    ).toBe(true);
    // Asking about an unknown subject must not allocate anything in Redis.
    expect(await real.exists(key)).toBe(0);
  });
});

// --- 18. bounded key growth ------------------------------------------------------

describe('bounded key growth', () => {
  it('creates exactly one key per distinct subject and expires each', async () => {
    const keys = Array.from({ length: 5 }, () => testKey('growth'));
    for (const key of keys) {
      await consumeRateLimit(real, [{ key, capacity: 1, windowMillis: 1_000, commit: true }]);
    }
    for (const key of keys) {
      expect(await real.exists(key)).toBe(1);
    }
    // Every one is on a bounded clock, so none can outlive its window and accumulate.
    for (const key of keys) {
      expect(await real.pttl(key)).toBeLessThanOrEqual(1_000);
    }
    await eventually(async () => (await real.exists(keys[0])) === 0, { timeoutMillis: 15_000 });
  });

  it('writes no key at all for a refused request, so a flood cannot create unbounded keys', async () => {
    const key = testKey('flood');
    const dimension = { key, capacity: 1, windowMillis: WINDOW, commit: true };
    await consumeRateLimit(real, [dimension]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect((await consumeRateLimit(real, [dimension])).allowed).toBe(false);
    }
    // One subject, one key, whatever the request volume.
    const found = await real.keys(`{${RATE_LIMIT_KEY_TAG}}:*`);
    expect(found.filter((entry) => entry === key)).toHaveLength(1);
  });
});
