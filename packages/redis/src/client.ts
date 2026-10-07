import { Redis, type RedisOptions } from 'ioredis';

export type RedisConnectionStatus = 'connecting' | 'ready' | 'reconnecting' | 'end';

export interface CreateRedisClientOptions {
  /**
   * Upper bound on establishing a connection. Applies to the initial connect and
   * to reconnects.
   */
  readonly connectTimeoutMillis?: number;
}

export interface PingRedisOptions {
  /**
   * Fail fast instead of waiting on a half-open or unreachable server. Readiness
   * probes set this so a down dependency is reported rather than queued.
   */
  readonly timeoutMillis?: number;
}

/**
 * Create a Redis client for one logical database.
 *
 * Stage 1 establishes connectivity and lifecycle only. Caching, BullMQ queues,
 * rate limiting, and short-lived application state are deliberately not
 * implemented yet and must arrive with the stage that needs them.
 *
 * ioredis is used rather than the official node-redis client because BullMQ is
 * the documented future consumer of this connection and BullMQ's guidance is
 * written against ioredis.
 *
 * Connection behaviour:
 *   - The client starts connecting immediately so that a healthy Redis is usable
 *     without an explicit connect step.
 *   - Commands issued before the socket is ready wait in the offline queue
 *     rather than failing, so normal application traffic is not lost during a
 *     cold start.
 *   - Readiness checks bound their own wait, so a down dependency is reported as
 *     not ready instead of hanging a probe.
 *
 * BullMQ is not wired up in this stage. A BullMQ worker additionally needs
 * `maxRetriesPerRequest: null`; that belongs with the queue stage.
 *
 * Tenant scoping is deliberately not implemented here. Cache keys, rate-limit
 * buckets, and job payloads are tenant-scoped concerns that belong to the stages
 * that introduce tenants and background work.
 */
export function createRedisClient(url: string, options: CreateRedisClientOptions = {}): Redis {
  const clientOptions: RedisOptions = {
    connectTimeout: options.connectTimeoutMillis ?? 5_000,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  };
  return new Redis(url, clientOptions);
}

/**
 * Verify Redis is reachable. Throws on failure, including on timeout; callers
 * decide how to report it. The underlying error is discarded because ioredis
 * error messages can contain the connection password.
 */
export async function pingRedis(client: Redis, options: PingRedisOptions = {}): Promise<void> {
  const timeoutMillis = options.timeoutMillis;
  if (timeoutMillis === undefined) {
    await expectPong(client);
    return;
  }
  let timer;
  try {
    await Promise.race([
      expectPong(client),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Redis ping timed out')), timeoutMillis);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectPong(client: Redis): Promise<void> {
  const reply = await client.ping();
  if (reply !== 'PONG') {
    throw new Error('Redis PING did not return PONG');
  }
}

/** Close the connection. Safe to call more than once. */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'end') {
    return;
  }
  try {
    await client.quit();
  } catch {
    // quit() rejects when the socket is already gone; disconnect() is the
    // forceful fallback and avoids surfacing a shutdown-time error.
    client.disconnect();
  }
}
