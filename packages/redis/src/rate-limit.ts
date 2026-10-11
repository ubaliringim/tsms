/**
 * Atomic, multi-dimensional rate limiting over Redis - Stage 2.6.
 *
 * One Lua script charges several independent dimensions in a single atomic step. A request is
 * admitted only when *every* dimension has capacity, and **nothing is written unless every
 * dimension admits**. That all-or-nothing rule is deliberate: charging one dimension while
 * rejecting on another would let a caller burn an unrelated dimension's budget, and it would make
 * "was this request counted" depend on which dimension happened to deny first.
 *
 * The script uses a token bucket per dimension rather than a fixed window, so a client cannot send
 * twice the allowance by straddling a window boundary. Buckets are stored as a two-field hash and
 * the expiry is set by the same script that creates the key, so there is no `INCR`-then-`EXPIRE`
 * window in which a crash could leave a key that never expires.
 *
 * Time comes from Redis `TIME`, not from the caller. Every API instance therefore refills the same
 * bucket at the same rate regardless of local clock skew, and no request can influence the clock.
 *
 * ## Guarantees, and their limits
 *
 * - **Atomic.** Redis runs one script at a time, so concurrent requests cannot exceed the
 *   configured allowance: the check and the write happen inside the same indivisible step.
 * - **Single slot.** Every key carries the `{tsms-rl}` hash tag, so a multi-key script stays within
 *   one cluster slot if Redis Cluster is ever used. Concentration into one slot is the price; for
 *   this workload it is far cheaper than `CROSSSLOT` failures.
 * - **Bounded keys.** A key expires after exactly one window, which is also the time it takes to
 *   refill to capacity. Cardinality is bounded by distinct subjects seen within one window.
 * - **No partial writes.** See the all-or-nothing rule above.
 * - **Not claimed:** strict fairness between dimensions, guaranteed slot-level ordering across
 *   Redis Cluster, or any protection when Redis is unavailable. Availability failure is the caller's
 *   decision; this module only reports it, by rejecting the promise.
 */

import type { Redis } from 'ioredis';

/** Fixed hash tag. Keeps every rate-limit key in one slot for a multi-key script. */
export const RATE_LIMIT_KEY_TAG = 'tsms-rl';

/** Bounds on a dimension. Rejecting outside these keeps the Lua arithmetic exact (2^53). */
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 10_000;
const MIN_WINDOW_MILLIS = 1_000;
const MAX_WINDOW_MILLIS = 3_600_000;

/** One token expressed in thousandths, so refill arithmetic stays in integer Lua numbers. */
const TOKEN_SCALE = 1_000;

/**
 * Upper bound on a single Redis round trip. A limiter that waits indefinitely is an availability
 * hole; one that fails fast turns a Redis problem into a bounded, sanitized refusal instead.
 */
export const DEFAULT_REDIS_TIMEOUT_MILLIS = 750;

/**
 * Evaluate every dimension's token bucket atomically, and charge only those marked for charging.
 *
 * Keys are read on every path. On the allow path only, dimensions marked `commit` are written, always
 * with their expiry set by this same script. Dimensions whose bucket is empty contribute the longest
 * wait, so the caller receives a retry hint that is valid for its slowest dimension without revealing
 * which one that was.
 *
 * A dimension marked `commit: false` is a check that costs nothing, which is what separates a
 * pre-flight admission test from a post-hoc charge for a request that actually turned out to fail.
 */
const CONSUME_SCRIPT = `
local scale = ${TOKEN_SCALE}
local dimensions = #KEYS
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

local window = {}
local current = {}
local allowed = true
local longestWait = 0

for index = 1, dimensions do
  local bucketCapacity = tonumber(ARGV[(index - 1) * 3 + 1])
  local bucketWindow = tonumber(ARGV[(index - 1) * 3 + 2])
  window[index] = bucketWindow
  local state = redis.call('HMGET', KEYS[index], 't', 'm')
  local tokens = tonumber(state[1])
  local stamp = tonumber(state[2])
  if tokens == nil or stamp == nil then
    tokens = bucketCapacity * scale
    stamp = now
  end
  local elapsed = now - stamp
  if elapsed < 0 then
    elapsed = 0
  elseif elapsed > bucketWindow then
    elapsed = bucketWindow
  end
  local level = tokens + math.floor(elapsed * bucketCapacity * scale / bucketWindow)
  local ceiling = bucketCapacity * scale
  if level > ceiling then
    level = ceiling
  end
  current[index] = level
  if level < scale then
    allowed = false
    local wait = math.ceil((scale - level) * bucketWindow / (bucketCapacity * scale))
    if wait > longestWait then
      longestWait = wait
    end
  end
end

if allowed == false then
  return {0, longestWait}
end

for index = 1, dimensions do
  local charged = tonumber(ARGV[(index - 1) * 3 + 3])
  if charged == 1 then
    redis.call('HSET', KEYS[index], 't', current[index] - scale, 'm', now)
    redis.call('PEXPIRE', KEYS[index], window[index])
  end
end

return {1, 0}
`;

/**
 * Return one token to every dimension, clamped to capacity.
 *
 * Only the reservation is undone - the refill is recomputed from Redis time, so a refunded bucket holds
 * exactly what a never-charged bucket would hold. That keeps a refund indistinguishable from a request
 * that was never metered, which matters because the whole point is that a legitimate request should
 * cost nothing observable.
 *
 * A key that has already expired is simply absent from `HMGET`; it is not recreated. An attacker must
 * not be able to resurrect a bucket that has already lapsed.
 */
const REFUND_SCRIPT = `
local scale = ${TOKEN_SCALE}
local dimensions = #KEYS
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

for index = 1, dimensions do
  local bucketCapacity = tonumber(ARGV[(index - 1) * 3 + 1])
  local bucketWindow = tonumber(ARGV[(index - 1) * 3 + 2])
  local state = redis.call('HMGET', KEYS[index], 't', 'm')
  local tokens = tonumber(state[1])
  local stamp = tonumber(state[2])
  if tokens ~= nil and stamp ~= nil then
    local level = tokens
    if now > stamp then
      level = tokens + math.floor((now - stamp) * bucketCapacity * scale / bucketWindow)
    end
    local ceiling = bucketCapacity * scale
    if level + scale > ceiling then
      level = ceiling
    else
      level = level + scale
    end
    redis.call('HSET', KEYS[index], 't', level, 'm', now)
    redis.call('PEXPIRE', KEYS[index], bucketWindow)
  end
end

return 1
`;

/**
 * A single independently metered dimension of one request.
 *
 * `commit` is what makes the limiter correct rather than merely useful.
 *
 * `true` means the request **reserves** a token at admission: the check and the write happen together,
 * so N simultaneous requests cannot all pass an untouched bucket. A reservation is later given back by
 * {@link refundRateLimit} if the request turned out not to be abuse.
 *
 * `false` means the dimension is **checked but not charged**. It contributes to the decision and to the
 * retry calculation while writing nothing, which is correct only where the outcome is already known -
 * a meter that counts requests, rather than failures.
 */
export interface RateLimitDimension {
  /**
   * Fully derived Redis key. It is opaque by construction: callers are expected to pass a
   * domain-separated HMAC, never a raw address, token, or other sensitive input.
   */
  readonly key: string;
  /** Tokens available per window. */
  readonly capacity: number;
  /** Length of the window, and the key's time to live. */
  readonly windowMillis: number;
  /** Reserve a token on admission, or inspect without writing. See the interface comment. */
  readonly commit: boolean;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Bounded wait before every dimension has capacity. Zero when allowed. */
  readonly retryAfterMillis: number;
}

export interface ConsumeRateLimitOptions {
  readonly timeoutMillis?: number;
}

/**
 * Enforcement could not be confirmed.
 *
 * Callers must treat this as "protection unknown", not as "allowed". It is raised for a timeout, a
 * connection failure, a Redis error, and a reply this module cannot interpret - including a reply
 * that is well-formed Redis but not a verdict this code is prepared to act on.
 */
export class RateLimitUnavailableError extends Error {
  constructor(reason: 'timeout' | 'redis' | 'malformed_reply') {
    super(`Rate limit enforcement unavailable: ${reason}`);
    this.name = 'RateLimitUnavailableError';
  }
}

/** Keys must stay inside one hash-tagged namespace so a slot collision cannot be constructed. */
const VALID_KEY = /^\{tsms-rl\}:[a-z0-9-]{1,32}:[a-z0-9-]{1,32}:[0-9a-f]{32,64}$/;

/**
 * Reject an unusable dimension before any Redis call.
 *
 * A non-positive or fractional capacity would divide by zero or silently mis-refill; an unbounded
 * window would let a key outlive any sensible retry advice and would grow the arithmetic past the
 * range Lua represents exactly. Both are configuration faults, so they fail loudly here rather than
 * becoming an accidental bypass.
 */
function validateDimension(dimension: RateLimitDimension, index: number): void {
  if (typeof dimension.key !== 'string' || !VALID_KEY.test(dimension.key)) {
    throw new Error(`Rate limit dimension ${index} has a malformed key`);
  }
  const { capacity, windowMillis } = dimension;
  if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
    throw new Error(
      `Rate limit dimension ${index} capacity must be an integer between ${MIN_CAPACITY} and ${MAX_CAPACITY}`,
    );
  }
  if (
    !Number.isInteger(windowMillis) ||
    windowMillis < MIN_WINDOW_MILLIS ||
    windowMillis > MAX_WINDOW_MILLIS
  ) {
    throw new Error(
      `Rate limit dimension ${index} window must be an integer between ${MIN_WINDOW_MILLIS} and ${MAX_WINDOW_MILLIS} milliseconds`,
    );
  }
}

/** A verdict is only acted on if it came back with the exact shape the script promises. */
function parseVerdict(reply: unknown): RateLimitVerdict {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new RateLimitUnavailableError('malformed_reply');
  }
  const [allowed, retryAfterMillis] = reply as [unknown, unknown];
  if (typeof allowed !== 'number' || (allowed !== 0 && allowed !== 1)) {
    throw new RateLimitUnavailableError('malformed_reply');
  }
  if (typeof retryAfterMillis !== 'number' || !Number.isFinite(retryAfterMillis)) {
    throw new RateLimitUnavailableError('malformed_reply');
  }
  if (retryAfterMillis < 0) throw new RateLimitUnavailableError('malformed_reply');
  if (allowed === 1 && retryAfterMillis !== 0)
    throw new RateLimitUnavailableError('malformed_reply');
  return { allowed: allowed === 1, retryAfterMillis };
}

/**
 * Bound a Redis round trip.
 *
 * The timer is cleared in `finally`, so a resolved request does not keep the event loop alive and a
 * timeout cannot later reject an already-settled promise.
 */
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

/** Shared validation and deduplication, so reserve and refund cannot disagree about what is valid. */
function validateDimensions(dimensions: readonly RateLimitDimension[]): void {
  if (dimensions.length === 0) throw new Error('At least one rate limit dimension is required');
  dimensions.forEach(validateDimension);

  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension.key)) {
      // Two identical keys would charge one bucket twice in a single script and report a
      // consumption the caller never made. Collapse is safer than a double charge, but silently
      // dropping a dimension weakens a limit, so it is a configuration error.
      throw new Error('Rate limit dimensions must have distinct keys');
    }
    seen.add(dimension.key);
  }
}

function flattenArguments(dimensions: readonly RateLimitDimension[]): number[] {
  return dimensions.flatMap((dimension) => [
    dimension.capacity,
    dimension.windowMillis,
    dimension.commit ? 1 : 0,
  ]);
}

/**
 * Reserve a token on every dimension, or on none.
 *
 * **Atomic.** All dimensions are read and, only if all admit, written in one script invocation, so
 * concurrent requests contend for real state instead of all reading the same untouched bucket. That is
 * what closes the bypass in which N simultaneous requests each observed a full meter and all proceeded.
 *
 * **Reserve, not final charge.** The token is returned by {@link refundRateLimit} when the request turns
 * out not to be abuse, so a legitimate success costs no budget while a failure keeps its reservation.
 *
 * Rejects with `RateLimitUnavailableError` whenever enforcement cannot be confirmed. It never resolves
 * to `allowed: true` as a fallback: silently permitting traffic because Redis was unreachable would
 * remove the very protection this stage exists to provide.
 */
export async function consumeRateLimit(
  client: Redis,
  dimensions: readonly RateLimitDimension[],
  options: ConsumeRateLimitOptions = {},
): Promise<RateLimitVerdict> {
  validateDimensions(dimensions);

  const timeoutMillis = options.timeoutMillis ?? DEFAULT_REDIS_TIMEOUT_MILLIS;
  const keys = dimensions.map((dimension) => dimension.key);

  let reply: unknown;
  try {
    reply = await withTimeout(
      client.eval(CONSUME_SCRIPT, keys.length, ...keys, ...flattenArguments(dimensions)),
      timeoutMillis,
      () => new RateLimitUnavailableError('timeout'),
    );
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) throw error;
    // ioredis surfaces connection failures, command errors and queue timeouts alike. The message
    // can contain the connection password, so it is discarded rather than wrapped.
    throw new RateLimitUnavailableError('redis');
  }
  return parseVerdict(reply);
}

/**
 * Return one reserved token per dimension, atomically.
 *
 * This is what makes "a legitimate success is free" an enforced property rather than an aspiration.
 * Admission reserves a token so that concurrent requests genuinely contend; a request that turns out
 * to be legitimate gives the reservation back, so the meter measures *failures* while remaining safe
 * under concurrency.
 *
 * The count is clamped to capacity, so a repeated refund cannot manufacture budget beyond what the
 * policy allows. A refunded key is rewritten with the window's TTL rather than extended indefinitely, so
 * a subject that stops generating traffic cannot hold a bucket alive.
 *
 * Failures are swallowed: a lost refund costs the requester one unit of its own allowance, which is
 * far better than converting a legitimate sign-in into an error.
 */
export async function refundRateLimit(
  client: Redis,
  dimensions: readonly RateLimitDimension[],
  options: ConsumeRateLimitOptions = {},
): Promise<void> {
  validateDimensions(dimensions);
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_REDIS_TIMEOUT_MILLIS;
  const keys = dimensions.map((dimension) => dimension.key);

  try {
    await withTimeout(
      client.eval(REFUND_SCRIPT, keys.length, ...keys, ...flattenArguments(dimensions)),
      timeoutMillis,
      () => new RateLimitUnavailableError('timeout'),
    );
  } catch {
    // Deliberately swallowed; see the method comment.
  }
}
