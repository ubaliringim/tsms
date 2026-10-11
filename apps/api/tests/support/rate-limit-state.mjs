/**
 * Rate-limit state reset for the pre-existing Stage 2.4 and Stage 2.5 integration suites.
 *
 * Those suites were written before any authentication limit existed, and each one drives dozens of
 * requests through a single application on a single loopback address. That is exactly the traffic a
 * per-source meter is designed to refuse, so without isolation these suites would spend one test's
 * budget on another and fail for a reason that has nothing to do with what they assert.
 *
 * This is the same hygiene those suites already apply to their database fixtures: each test gets its
 * own users, and now each also gets its own limiter state. Nothing about the limiter is stubbed - the
 * real Redis, the real script, and the real guard run in every test. Only the accumulated budget is
 * reset, so an assertion about enforcement still exercises the production path end to end.
 *
 * Scope is deliberate: only the `{tsms-rl}` hash-tagged namespace is touched. Redis key patterns are
 * glob-based and the tag is a literal, so this cannot match another namespace, and the API integration
 * suite runs with `fileParallelism: false`, so no concurrent suite's state is disturbed.
 *
 * The Stage 2.6 suite deliberately does not use this: its assertions are about limits accumulating,
 * so it manages its own state through dedicated applications with dedicated secrets.
 */

import { createRedisClient, closeRedis } from '@tsms/redis';
import { ARGON2ID_SEMAPHORE_KEY } from '@tsms/redis';

/**
 * Delete this suite's rate-limit keys, leaving all other Redis state untouched.
 *
 * **The Argon2id semaphore key is deliberately excluded.** The API and Redis integration suites run in
 * parallel against the same logical Redis database, and the semaphore is shared deployment state: one
 * semaphore spans every instance. Deleting it from an API test's `beforeEach` would yank a semaphore out
 * from under the Redis suite's own tests mid-run, which produced a real intermittent failure here.
 *
 * The API suites never leave semaphore holders behind anyway - every permit is released in a `finally`, and
 * a process that dies is covered by lease expiry - so excluding the key loses nothing.
 */
const PROTECTED_KEYS = new Set([ARGON2ID_SEMAPHORE_KEY]);

export async function resetRateLimitState(redisUrl) {
  const client = createRedisClient(redisUrl);
  try {
    const keys = (await client.keys('{tsms-rl}:*')).filter((key) => !PROTECTED_KEYS.has(key));
    if (keys.length > 0) await client.del(...keys);
  } finally {
    await closeRedis(client);
  }
}
