import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { closeRedis, createRedisClient, pingRedis, type Redis } from '@tsms/redis';
import type { DependencyState } from './database.service.js';

const READINESS_TIMEOUT_MILLIS = 2_000;

/**
 * Owns the process-wide Redis client.
 *
 * Stage 1 establishes connectivity, lifecycle, and readiness only. Caching,
 * BullMQ queues, rate limiting, and short-lived application state arrive with
 * the stage that needs them.
 *
 * Tenant scoping is not implemented here. Cache keys, rate-limit buckets, and job
 * payloads must all be tenant-scoped once tenants exist; that is a Stage 3+
 * requirement, not a property of this client.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = createRedisClient(redisUrl, { connectTimeoutMillis: READINESS_TIMEOUT_MILLIS });
  }

  /**
   * Exposed for the stages that add caching or queues. Deliberately not used by
   * the API today.
   */
  get redis(): Redis {
    return this.client;
  }

  async check(): Promise<DependencyState> {
    try {
      await pingRedis(this.client, { timeoutMillis: READINESS_TIMEOUT_MILLIS });
      return 'up';
    } catch {
      // ioredis error messages can contain the password. Readiness must not.
      return 'down';
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client);
  }
}
