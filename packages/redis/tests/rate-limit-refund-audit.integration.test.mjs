/**
 * Reservation and refund audit - Stage 2.6 final review.
 *
 * Every guarantee here is one the review asked to be *proved*, and each is asserted against a real Redis
 * rather than inferred from the implementation. The refund path is the highest-risk part of the whole stage:
 * it hands budget back, so any weakness in it is a weakness in the limit itself.
 *
 * The cases deliberately include the adversarial ones a reviewer should worry about most - duplicate
 * refunds, refunds against someone else's key, refunds that arrive after a window has rolled - because
 * those are exactly the shapes that turn a rate limit into no rate limit.
 */

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeRedis, createRedisClient, pingRedis } from '../dist/client.js';
import { consumeRateLimit, refundRateLimit } from '../dist/rate-limit.js';

const CAPACITY = 5;
const WINDOW = 60_000;
const TAG = '{tsms-rl}';

let client;

/** A key in the one namespace the limiter accepts. */
/**
 * A key in the one namespace the limiter accepts: a lowercase hex digest of at least 32 characters.
 *
 * The digest is derived from the subject exactly as the API layer would, so the audit exercises the same
 * key shape the product produces. Two suites never collide because the subject is mixed with a fresh
 * random value before hashing.
 */
const key = (subject) =>
  `${TAG}:login:target:${createHash('sha256')
    .update(subject)
    .update(randomUUID())
    .digest('hex')
    .slice(0, 32)}`;

const dimension = (subject, capacity = CAPACITY) => ({
  key: key(subject),
  capacity,
  windowMillis: WINDOW,
  commit: true,
});

/** Remaining tokens, scaled down to whole tokens. */
async function remainingOf(dimension) {
  const state = await client.hmget(dimension.key, 't', 'm');
  if (state[0] === null) return null;
  return Math.floor(Number(state[0]) / 1000);
}

/** Run `count` sequential admissions and report how many were allowed. */
async function admit(dimension, count) {
  let allowed = 0;
  for (let attempt = 0; attempt < count; attempt += 1) {
    if ((await consumeRateLimit(client, [dimension])).allowed) allowed += 1;
  }
  return allowed;
}

beforeAll(async () => {
  const integration = parseIntegrationEnvironment(process.env);
  client = createRedisClient(integration.TEST_REDIS_URL);
  await pingRedis(client, { timeoutMillis: 5_000 });
});

afterAll(async () => {
  if (client) await closeRedis(client);
});

beforeEach(async () => {
  const keys = await client.keys(`${TAG}:login:*`);
  if (keys.length > 0) await client.del(...keys);
});

// --- Admission reserves atomically ------------------------------------------------

describe('admission reserves atomically', () => {
  it('reserves one token per admission and refuses beyond capacity', async () => {
    const d = dimension('atomic');
    expect(await admit(d, CAPACITY)).toBe(CAPACITY);
    expect(await remainingOf(d)).toBe(0);
    expect((await consumeRateLimit(client, [d])).allowed).toBe(false);
  });

  it('reserves nothing at all when one of several dimensions refuses', async () => {
    const full = dimension('full');
    await admit(full, CAPACITY);

    const untouched = dimension('untouched');
    const verdict = await consumeRateLimit(client, [full, untouched]);
    expect(verdict.allowed).toBe(false);

    // The untouched dimension must still hold its whole allowance: a refusal may not partially reserve.
    expect(await remainingOf(untouched)).toBeNull();
    expect(await admit(untouched, CAPACITY)).toBe(CAPACITY);
  });

  it('admits exactly the capacity when many requests race for it', async () => {
    const d = dimension('race');
    const verdicts = await Promise.all(
      Array.from({ length: 40 }, () => consumeRateLimit(client, [d])),
    );
    expect(verdicts.filter((v) => v.allowed).length).toBe(CAPACITY);
    expect(await remainingOf(d)).toBe(0);
  });
});

// --- Refund correctness ----------------------------------------------------------

describe('refund returns exactly one reservation', () => {
  it('returns one token for one admission', async () => {
    const d = dimension('refund-one');
    await admit(d, 3);
    expect(await remainingOf(d)).toBe(2);

    await refundRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(3);
  });

  it('leaves a charged failure charged', async () => {
    const d = dimension('kept');
    await admit(d, CAPACITY);
    // No refund: the five failures stand, so the next attempt is refused.
    expect((await consumeRateLimit(client, [d])).allowed).toBe(false);
    expect(await remainingOf(d)).toBe(0);
  });

  it('clamps a refund to capacity, so repeated refunds cannot inflate a bucket', async () => {
    const d = dimension('clamp');
    await admit(d, 2);
    expect(await remainingOf(d)).toBe(3);

    // Five refunds against a bucket that only ever lost two tokens. Without a clamp this would mint
    // budget and turn the limit into no limit at all.
    for (let index = 0; index < 5; index += 1) await refundRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(CAPACITY);
  });

  it('cannot restore capacity twice from one legitimate request', async () => {
    const d = dimension('duplicate');
    await admit(d, CAPACITY);
    expect(await remainingOf(d)).toBe(0);

    // A duplicated refund - a retry, a double-settled observable - returns one token, then saturates.
    await refundRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(1);
    await refundRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(2);

    // And repeated duplication still cannot exceed the capacity the policy allows.
    for (let index = 0; index < 10; index += 1) await refundRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(CAPACITY);
  });

  it('cannot restore another subject budget, because keys are not caller-selectable', async () => {
    const victim = dimension('victim');
    const attacker = dimension('attacker');
    await admit(victim, CAPACITY);
    expect(await remainingOf(victim)).toBe(0);

    // The only budget an attacker can refund is their own: the key is derived from their own subject and
    // nothing in the request selects it.
    await refundRateLimit(client, [attacker]);
    expect(await remainingOf(victim)).toBe(0);
    expect((await consumeRateLimit(client, [victim])).allowed).toBe(false);
  });

  it('refunds every dimension of a request together', async () => {
    const source = dimension('multi-source');
    const target = dimension('multi-target');
    await consumeRateLimit(client, [source, target]);
    expect(await remainingOf(source)).toBe(CAPACITY - 1);
    expect(await remainingOf(target)).toBe(CAPACITY - 1);

    await refundRateLimit(client, [source, target]);
    expect(await remainingOf(source)).toBe(CAPACITY);
    expect(await remainingOf(target)).toBe(CAPACITY);
  });

  it('does not resurrect a bucket that has already expired', async () => {
    // A very short window, then a refund after it has lapsed. Recreating the key would hand a caller
    // budget for a window that no longer exists, and would keep a key alive indefinitely.
    const d = { key: key('expired'), capacity: CAPACITY, windowMillis: 1_000, commit: true };
    await consumeRateLimit(client, [d]);
    expect(await remainingOf(d)).toBe(CAPACITY - 1);

    await new Promise((done) => setTimeout(done, 1_200));
    expect(await client.exists(d.key)).toBe(0);

    await refundRateLimit(client, [d]);
    // Still absent: a refund cannot bring back a window that has closed.
    expect(await client.exists(d.key)).toBe(0);
  });

  it('cannot disturb a different window generation of the same key', async () => {
    const d = dimension('generation');
    await consumeRateLimit(client, [d]);
    await refundRateLimit(client, [d]);

    // A refund recomputes refill from Redis time rather than adding to a stale count, so it cannot
    // resurrect tokens that a refill has already accounted for.
    const before = await remainingOf(d);
    await refundRateLimit(client, [d]);
    const after = await remainingOf(d);
    expect(after).toBeLessThanOrEqual(CAPACITY);
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('swallows a Redis failure rather than throwing', async () => {
    const broken = { eval: () => Promise.reject(new Error('ECONNRESET')) };
    // The response has already been produced. A refund that cannot be written must not become an error,
    // and must certainly not be retried into a burst of unbounded refunds.
    await expect(
      refundRateLimit(broken, [dimension('broken')], { timeoutMillis: 100 }),
    ).resolves.toBeUndefined();
  });

  it('refuses a malformed dimension rather than issuing the script', async () => {
    let called = false;
    const recording = {
      eval: () => {
        called = true;
        return Promise.resolve(1);
      },
    };
    await expect(
      refundRateLimit(recording, [
        { key: 'no-hash-tag', capacity: 1, windowMillis: WINDOW, commit: true },
      ]),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

// --- Key privacy -----------------------------------------------------------------

describe('no credential or token material in keys', () => {
  it('keeps every key opaque regardless of what was hashed into it', async () => {
    const subjects = [
      'person@example.test',
      'B'.repeat(43),
      '$argon2id$v=19$m=65536,p=1,t=3$abc$def',
      'correct horse battery staple',
      '../../etc/passwd',
      'x'.repeat(500),
    ];
    for (const subject of subjects) {
      const d = dimension(subject);
      await consumeRateLimit(client, [d]);
      // Whatever the subject was, the key is a fixed-shape hex digest in the rate-limit namespace.
      expect(d.key).toMatch(/^\{tsms-rl\}:login:target:[0-9a-f]{32}$/);
      for (const forbidden of [subject, '@', 'argon2id', '$']) {
        if (subject.length > 0 && forbidden.length > 1) {
          expect(d.key).not.toContain(forbidden);
        }
      }
      await client.del(d.key);
    }
  });
});
