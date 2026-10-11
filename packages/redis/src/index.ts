export { closeRedis, createRedisClient, pingRedis } from './client.js';
export type { Redis } from 'ioredis';
export type {
  CreateRedisClientOptions,
  PingRedisOptions,
  RedisConnectionStatus,
} from './client.js';
export {
  consumeRateLimit,
  refundRateLimit,
  RateLimitUnavailableError,
  RATE_LIMIT_KEY_TAG,
} from './rate-limit.js';
export type {
  ConsumeRateLimitOptions,
  RateLimitDimension,
  RateLimitVerdict,
} from './rate-limit.js';
export {
  acquireArgon2idSlot,
  argon2idHolders,
  releaseArgon2idSlot,
  renewArgon2idSlot,
  Argon2idAdmissionUnavailableError,
  ARGON2ID_SEMAPHORE_KEY,
} from './argon2id-semaphore.js';
export type { Argon2idSemaphoreOptions, Argon2idSlotDecision } from './argon2id-semaphore.js';
