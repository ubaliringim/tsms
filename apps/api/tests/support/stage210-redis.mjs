// Read-only view of the rate-limit namespace for tests that live outside this package (the web integration suite).
//
// It exists so such a test can ask "how many distinct source buckets did that traffic create?" without taking a
// dependency on the Redis package. It only lists keys in the `{tsms-rl}` namespace; it never writes or deletes.

import { closeRedis, createRedisClient } from '@tsms/redis';

/** Keys in the rate-limit namespace whose name starts with `prefix` (for example `login:source:`). */
export async function rateLimitKeys(redisUrl, prefix) {
  const client = createRedisClient(redisUrl);
  try {
    return (await client.keys(`{tsms-rl}:${prefix}*`)).sort();
  } finally {
    await closeRedis(client);
  }
}
