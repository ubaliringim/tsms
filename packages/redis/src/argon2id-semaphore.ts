/**
 * Bounded simultaneous Argon2id admission across API instances - Stage 2.6 hardening.
 *
 * ## Why this exists
 *
 * The rate limiter bounds how much verification work the fleet can be *asked to start* per minute.
 * That is not a bound on how much runs *at once*, and the difference is the whole problem: Argon2id
 * allocates 64 MiB per operation, and a token bucket that starts full will hand out its entire
 * capacity simultaneously. A 120-token budget therefore permits a 120-way concurrent burst, which is
 * several gigabytes of transient allocation.
 *
 * A per-process counter cannot fix this: each instance would allow its own share and the total would
 * scale with the fleet. So the bound is held in Redis and shared.
 *
 * ## Why a Redis-backed lease is safe here specifically
 *
 * A distributed semaphore is usually a dangerous thing to reach for, because a crashed holder leaks
 * capacity. That objection does not apply to *this* semaphore, because every endpoint that can reach
 * Argon2id already fails closed when Redis is unreachable: `login`, `password/forgot`, and
 * `password/reset` all refuse with `503` before their handler runs if the limiter cannot be consulted.
 * Adding a Redis-backed admission step therefore introduces **no new failure mode**. If Redis is down,
 * the request was already going to be refused before any Argon2id was attempted.
 *
 * ## Mechanism
 *
 * One sorted set of lease holders, each member a cryptographically random holder id scored by its
 * expiry. A single Lua script per operation keeps it atomic:
 *
 * - **Acquire**: prune expired members, refuse if at capacity, otherwise add this holder and extend
 *   the key's own TTL.
 * - **Release**: remove only this holder, and only if it is present. A delayed or duplicated release is
 *   a no-op and can never release another request's slot.
 * - **Renew**: extend this holder's expiry only if it is still present, so a release that races a renew
 *   cannot resurrect a freed slot.
 *
 * Member identity is a 32-byte `randomBytes` value, so a holder cannot be impersonated or guessed, and
 * the value is never derived from a credential, an address, or a token.
 *
 * ## Guarantees, and their limits
 *
 * Guaranteed:
 *
 * - At most `capacity` Argon2id operations may hold a slot across the whole deployment.
 * - Acquisition is atomic, so concurrent acquires cannot exceed capacity.
 * - A crashed, killed, or disconnected holder frees its slot when its lease expires. It never leaks
 *   capacity permanently.
 * - A release cannot free another holder's slot, and a duplicate release cannot free two.
 * - Redis unavailability refuses admission. There is no unlimited fallback.
 *
 * Explicitly not guaranteed:
 *
 * - **A lease that expires while its work is still running permits over-admission.** Bounded by the
 *   number of such holders, not by request volume. The lease is 30 s against a locally measured ~100 ms
 *   operation, and the holder renews every 10 s, so this needs a holder to be starved of its event loop
 *   or to run for over 30 s. It is stated rather than hidden, because a semaphore that pretended to be
 *   exact would be a worse claim than one that names its boundary.
 * - Clock dependence is limited to Redis `TIME`, so every instance agrees.
 *
 * Rejection is immediate: there is no queue. A caller that cannot get a slot is told so and may retry,
 * which is preferable to an unbounded backlog holding requests - and their 4 KiB bodies - in memory.
 */

import type { Redis } from 'ioredis';
import { RATE_LIMIT_KEY_TAG } from './rate-limit.js';

/** One key for the whole deployment. The shared hash tag keeps it in the limiter's slot. */
export const ARGON2ID_SEMAPHORE_KEY = `{${RATE_LIMIT_KEY_TAG}}:global:argon2id:holders`;

/** Holder ids are 32 random bytes, base64url. Never derived from anything a client controls. */
const HOLDER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Longest accepted lease. Bounds how long a crashed holder can occupy capacity. */
export const MAX_LEASE_MILLIS = 600_000;

/** An unbounded or non-positive lease would either leak capacity or expire before work completes. */
const MIN_LEASE_MILLIS = 1_000;

/** Default ceiling on one Redis round trip for an admission decision. */
const DEFAULT_TIMEOUT_MILLIS = 750;

/**
 * Take a slot, or report that none is free.
 *
 * Refuses rather than waiting: this is called immediately before a 64 MiB allocation, and queueing
 * would mean holding request bodies in memory for an unbounded time.
 */
const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local holder = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local held = redis.call('ZCARD', KEYS[1])
if held >= limit then
  return {0, held}
end
redis.call('ZADD', KEYS[1], now + lease, holder)
redis.call('PEXPIRE', KEYS[1], lease * 2)
return {1, held + 1}
`;

/**
 * Release only this holder's slot.
 *
 * The `ZSCORE` guard is what makes a delayed or duplicated release safe: a holder that has already
 * released, or whose lease already expired and was pruned, finds nothing and changes nothing. It can
 * never remove a different request's slot, because a member identifies exactly one holder.
 */
const RELEASE_SCRIPT = `
local holder = ARGV[1]
if redis.call('ZSCORE', KEYS[1], holder) == false then
  return 0
end
redis.call('ZREM', KEYS[1], holder)
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end
return 1
`;

/**
 * Extend this holder's lease.
 *
 * Only extends a member that is still present, so a renew that races a release cannot bring a freed slot
 * back. An absent member is reported, never recreated.
 */
const RENEW_SCRIPT = `
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local holder = ARGV[3]
if redis.call('ZSCORE', KEYS[1], holder) == false then
  return 0
end
redis.call('ZADD', KEYS[1], now + lease, holder)
redis.call('PEXPIRE', KEYS[1], lease * 2)
return 1
`;

export type Argon2idSlotDecision =
  | { readonly acquired: true; readonly held: number }
  | { readonly acquired: false; readonly held: number };

/**
 * Enforcement could not be confirmed, so no Argon2id may start.
 *
 * Distinct from a refused slot: this means the bound is unknown rather than known to be full.
 */
export class Argon2idAdmissionUnavailableError extends Error {
  constructor(reason: 'timeout' | 'redis' | 'malformed_reply') {
    super(`Argon2id admission unavailable: ${reason}`);
    this.name = 'Argon2idAdmissionUnavailableError';
  }
}

/** Same contract as the rate limiter: never resolve to "acquired" on an unreadable reply. */
function parseAcquire(reply: unknown): Argon2idSlotDecision {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Argon2idAdmissionUnavailableError('malformed_reply');
  }
  const [acquired, held] = reply as [unknown, unknown];
  if (typeof acquired !== 'number' || (acquired !== 0 && acquired !== 1)) {
    throw new Argon2idAdmissionUnavailableError('malformed_reply');
  }
  if (typeof held !== 'number' || !Number.isInteger(held) || held < 0) {
    throw new Argon2idAdmissionUnavailableError('malformed_reply');
  }
  return acquired === 1 ? { acquired: true, held } : { acquired: false, held };
}

/**
 * Read Redis server time in whole milliseconds.
 *
 * Every lease decision is taken against this clock rather than a local one, so instances with skewed
 * clocks still agree on when a lease has expired.
 */
async function redisMillis(client: Redis): Promise<number> {
  const clock = await client.time();
  // Redis replies to TIME with two bulk strings, so ioredis hands them over as strings, not numbers.
  // Coerce explicitly rather than assuming a numeric reply, and reject anything that is not exactly
  // two usable components: a clock that cannot be read must never be silently treated as zero, which
  // would expire every outstanding lease at once.
  if (!Array.isArray(clock) || clock.length < 2) {
    throw new Argon2idAdmissionUnavailableError('malformed_reply');
  }
  const seconds = Number(clock[0]);
  const micros = Number(clock[1]);
  if (!Number.isFinite(seconds) || !Number.isFinite(micros)) {
    throw new Argon2idAdmissionUnavailableError('malformed_reply');
  }
  return seconds * 1000 + Math.floor(micros / 1000);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMillis: number,
  failure: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure()), timeoutMillis);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Configuration faults are programming errors and must fail loudly, not silently degrade. */
function validate(limit: number, leaseMillis: number, holder: string): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Argon2id admission limit must be an integer of at least 1');
  }
  if (
    !Number.isInteger(leaseMillis) ||
    leaseMillis < MIN_LEASE_MILLIS ||
    leaseMillis > MAX_LEASE_MILLIS
  ) {
    throw new Error(
      `Argon2id lease must be an integer between ${MIN_LEASE_MILLIS} and ${MAX_LEASE_MILLIS} milliseconds`,
    );
  }
  if (!HOLDER_PATTERN.test(holder)) {
    throw new Error('Argon2id holder id must be 43 base64url characters');
  }
}

export interface Argon2idSemaphoreOptions {
  readonly limit: number;
  readonly leaseMillis: number;
  readonly timeoutMillis?: number;
  readonly key?: string;
}

/**
 * Acquire one Argon2id slot for the whole deployment.
 *
 * Callers must release the holder they receive, and must treat a rejection as `RateLimitUnavailable`
 * rather than as permission to proceed without a slot.
 */
export async function acquireArgon2idSlot(
  client: Redis,
  holder: string,
  options: Argon2idSemaphoreOptions,
): Promise<Argon2idSlotDecision> {
  const key = options.key ?? ARGON2ID_SEMAPHORE_KEY;
  validate(options.limit, options.leaseMillis, holder);
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;

  // The clock read is inside the same guard as the script. It is a Redis round trip like any other, so
  // an unreachable server must produce the same refusal here as it would below - not a raw ioredis
  // error escaping to a caller that is expecting an admission decision.
  let now: number;
  try {
    now = await withTimeout(
      redisMillis(client),
      timeoutMillis,
      () => new Argon2idAdmissionUnavailableError('timeout'),
    );
  } catch (error) {
    if (error instanceof Argon2idAdmissionUnavailableError) throw error;
    throw new Argon2idAdmissionUnavailableError('redis');
  }

  let reply: unknown;
  try {
    reply = await withTimeout(
      client.eval(ACQUIRE_SCRIPT, 1, key, now, options.limit, options.leaseMillis, holder),
      timeoutMillis,
      () => new Argon2idAdmissionUnavailableError('timeout'),
    );
  } catch (error) {
    if (error instanceof Argon2idAdmissionUnavailableError) throw error;
    // ioredis messages can contain the connection password, so the message is discarded.
    throw new Argon2idAdmissionUnavailableError('redis');
  }
  return parseAcquire(reply);
}

/** Release this holder's slot. Safe to call more than once, and safe after the lease has expired. */
export async function releaseArgon2idSlot(
  client: Redis,
  holder: string,
  options: { timeoutMillis?: number; key?: string } = {},
): Promise<void> {
  if (!HOLDER_PATTERN.test(holder))
    throw new Error('Argon2id holder id must be 43 base64url characters');
  const key = options.key ?? ARGON2ID_SEMAPHORE_KEY;
  try {
    await withTimeout(
      client.eval(RELEASE_SCRIPT, 1, key, holder),
      options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS,
      () => new Argon2idAdmissionUnavailableError('timeout'),
    );
  } catch {
    // Deliberately swallowed. The caller has finished its work and cannot use the result; the lease
    // expiry is the backstop that returns the slot.
  }
}

/** Extend this holder's lease while its work is still running. Never resurrects a released slot. */
export async function renewArgon2idSlot(
  client: Redis,
  holder: string,
  options: Argon2idSemaphoreOptions,
): Promise<boolean> {
  const key = options.key ?? ARGON2ID_SEMAPHORE_KEY;
  validate(options.limit, options.leaseMillis, holder);
  let now;
  try {
    now = await redisMillis(client);
  } catch {
    return false;
  }
  try {
    const reply = await withTimeout(
      client.eval(RENEW_SCRIPT, 1, key, now, options.leaseMillis, holder),
      options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS,
      () => new Argon2idAdmissionUnavailableError('timeout'),
    );
    return reply === 1;
  } catch {
    // A failed renewal means the lease may expire while work continues. That is a bounded
    // over-admission, recorded in the module comment, and is preferable to failing the in-flight
    // request whose work is already done.
    return false;
  }
}

/** Current holder count, for tests and operational inspection. */
export async function argon2idHolders(
  client: Redis,
  options: { key?: string } = {},
): Promise<number> {
  return client.zcard(options.key ?? ARGON2ID_SEMAPHORE_KEY);
}
