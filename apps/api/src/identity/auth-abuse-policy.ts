/**
 * Abuse protection for the authentication surface - Stage 2.6.
 *
 * Two responsibilities, kept separate on purpose:
 *
 * 1. **What is metered and how tightly** - {@link AUTH_ABUSE_POLICIES}. Frozen constants, not
 *    environment variables, because these are security decisions. An operator who can raise a limit
 *    from a shell profile can also disable the control, so the numbers live in reviewed source and
 *    change only through a reviewed change.
 *
 * 2. **Turning a request into key material** - {@link deriveAbuseKey}. Every subject becomes a
 *    domain-separated HMAC before it is sent to Redis.
 *
 * Enforcement itself is in the guard; the algorithm is `@tsms/redis`.
 *
 * ## Why these numbers
 *
 * They are conservative development defaults chosen against this system's actual costs, and they are
 * **not** presented as industry-standard guidance or as a guarantee about any attacker. Each is a
 * judgement that the owner may revise; the reasoning is recorded so the judgement can be challenged.
 *
 * Argon2id costs 64 MiB and three passes per verification (measured locally at roughly 100 ms), and
 * both login and password recovery deliberately verify on every ineligible request too, so that cost
 * is paid whether or not the attempt is real. The source limits are therefore set well below what
 * would throttle a person typing a password, and the per-account limits are tighter still: one
 * person's typos must not consume a whole shared network's allowance.
 *
 * | Endpoint                | Source (per network address) | Target (per account/token) | Why                                                                    |
 * | ----------------------- | ---------------------------- | --------------------------- | ---------------------------------------------------------------------- |
 * | `POST /auth/login`      | 10 per 5 min                 | 8 per 15 min                 | Bounds volume from one origin and guessing against one account.        |
 * | `POST /auth/password/forgot` | 5 per 15 min            | 3 per 1 h                   | Recovery is rarer than login; the target limit is the flood control.   |
 * | `POST /auth/password/reset`  | 10 per 15 min           | 10 per 15 min                | Bounds token guessing and Argon2id work from repeated bad submissions. |
 * | `GET /auth/me`          | 120 per 1 min                | none                         | Proportionate flood control only; it is not a guessing surface.        |
 * | `POST /auth/logout`     | 30 per 1 min                 | none                         | Proportionate; must not become a denial of service against a user.     |
 *
 * Stage 2.9 additions (all provisional): `login`/`forgot`/`reset` also have a malformed-request meter of 30 per
 * 5 min per source, and `login` has a per-account success meter of 10 per 10 min. See
 * docs/security/RATE_LIMITING.md.
 *
 * A failed login costs both dimensions, so a distributed attacker is bounded by whichever it exhausts
 * first, and a shared-NAT site is bounded per account rather than being shut out wholesale.
 *
 * The per-account and per-target limits are abuse controls, **not** a lockout: they bound a rolling
 * window and refill continuously, so an account is never disabled and there is no state an attacker
 * can latch into. Nobody is locked out of their own account by an attacker, and legitimate typos
 * self-correct within the window.
 *
 * ## The global Argon2id budget
 *
 * Per-source and per-account limits do not bound total verification work: an attacker with many
 * addresses and many accounts stays under every local limit while still driving the CPU. A single
 * process-local counter cannot help either, because each API instance would allow its own share and
 * the total would scale with the fleet.
 *
 * So one additional dimension meters the expensive operation itself, across the whole deployment: a
 * single global token bucket on Argon2id verifications. It is enforced through the same atomic script
 * and therefore shares state across instances. It bounds how much verification work the fleet can be
 * asked to start, not how much CPU one machine has.
 *
 * It is deliberately a **rate** budget, not a concurrency semaphore. A true simultaneous-verification
 * cap needs leases with expiry and careful release semantics, and a half-built distributed semaphore
 * is worse than an honest rate bound: it can deadlock or double-release. See the escalation in the
 * Stage 2.6 documentation - bounding in-flight 64 MiB allocations per instance is a real follow-up,
 * not something this stage claims to have solved.
 */

import { createHmac } from 'node:crypto';
import { RATE_LIMIT_KEY_TAG, type RateLimitDimension } from '@tsms/redis';

/** Every key lives under one hash tag so a multi-key script stays inside a single slot. */
const KEY_PREFIX = `{${RATE_LIMIT_KEY_TAG}}`;

/**
 * Key components are restricted to this shape, and the derived part is a fixed-width hex digest, so
 * a subject can never introduce a colon, a glob, a wildcard, or unbounded length into a Redis key.
 */
const KEY_COMPONENT = /^[a-z0-9-]{1,32}$/;

/** Longest accepted subject before hashing. Bounds work on attacker-controlled input. */
const MAX_SUBJECT_LENGTH = 512;

/** The five authenticated endpoints, named as policy keys. */
export type AbuseEndpoint = 'login' | 'forgot' | 'reset' | 'me' | 'logout';

/**
 * The dimensions a request can be metered on.
 *
 * - `source` / `target`: the credential meters. Reserved at admission, returned for a non-abuse outcome.
 * - `workload`: the global Argon2id budget. Charged only where an Argon2id operation is actually admitted
 *   (Stage 2.9), never at request admission.
 * - `invalid`: a cheap per-source meter for requests the controller would reject as malformed (Stage 2.9).
 * - `success`: a per-account meter on successful logins (Stage 2.9).
 */
export type AbuseDimension = 'source' | 'target' | 'workload' | 'invalid' | 'success';

/**
 * One meter: capacity per window.
 *
 * `capacity` is both the burst size and the sustained rate, because a token bucket refills to
 * capacity over one window. That is a deliberate simplification: a second refill-rate parameter
 * would allow a configuration no threat model requires.
 */
export interface AbusePolicy {
  readonly endpoint: AbuseEndpoint;
  readonly dimension: AbuseDimension;
  readonly capacity: number;
  readonly windowMillis: number;
  /**
   * Whether the endpoint may proceed when Redis enforcement cannot be confirmed. Only the two
   * non-credential endpoints opt out; see `failClosedEndpoints`.
   */
  readonly requiresEnforcement: boolean;
}

/**
 * Endpoints that fail closed when Redis is unreachable.
 *
 * Login and both recovery endpoints either spend Argon2id or issue a recovery token, so proceeding
 * without a confirmed limit would silently reopen exactly the attacks this stage closes. `me` and
 * `logout` perform no expensive verification, so a Redis outage degrades them to unthrottled rather
 * than unavailable - see {@link AbuseProtectionService} for the logout cookie behaviour.
 */
export const FAIL_CLOSED_ENDPOINTS: ReadonlySet<AbuseEndpoint> = new Set<AbuseEndpoint>([
  'login',
  'forgot',
  'reset',
]);

/**
 * Meter for endpoints whose abuse is request **volume** rather than failed attempts.
 *
 * `forgot` belongs here for a specific reason: the threat it exists to stop is email flooding, and a
 * flooding request *succeeds* - it answers `202` and sends a message. A failure-metered forgot would
 * therefore never limit anything, however many messages an attacker sent to one victim. `me` and
 * `logout` have no credential to fail at all.
 *
 * `login` and `reset` are excluded: they have credentials to guess, so charging their successes would
 * penalise correct sign-ins and lock out colleagues sharing one NAT address.
 */
export const VOLUME_METERED_ENDPOINTS: ReadonlySet<AbuseEndpoint> = new Set<AbuseEndpoint>([
  'forgot',
  'me',
  'logout',
]);

/**
 * Whether an endpoint meters requests or only failed attempts.
 *
 * Named here, beside the policy, so the enforcement layer never has to encode which abuse model
 * applies to which route.
 */
export function countsEveryRequest(endpoint: AbuseEndpoint): boolean {
  return VOLUME_METERED_ENDPOINTS.has(endpoint);
}

/**
 * Global verification budget.
 *
 * Sized against a measured ~100 ms per Argon2id verification: 120 per minute is roughly two
 * verifications per second sustained, which is above what a school-sized login surface generates
 * normally but far below what a distributed attacker needs to saturate a fleet. It is a rate cap on
 * work *started*; it does not bound how many run at once, and it is shared by every API instance.
 */
export const GLOBAL_ARGON2ID_BUDGET = Object.freeze({
  capacity: 120,
  windowMillis: 60_000,
});

/**
 * Deployment-wide bound on **simultaneous** Argon2id operations.
 *
 * ## Why the rate budget above is not enough
 *
 * A token bucket bounds work *started per window*, which is a different quantity from work running at
 * once. Argon2id allocates 64 MiB per operation, and a bucket that starts full hands out its entire
 * capacity at once: 120 starts in the same instant is roughly 7.7 GiB of transient allocation before
 * any refill is considered. The rate budget limits how *fast* the fleet can be driven; only this limit
 * bounds how *much* it allocates at any instant.
 *
 * A process-local counter cannot provide that bound, because each API instance would allow its own
 * share and the fleet-wide total would scale with the number of replicas. The bound is therefore held
 * in Redis and shared, and enforced immediately before the 64 MiB allocation.
 *
 * ## Sizing
 *
 * Eight concurrent operations is 512 MiB of transient allocation fleet-wide at the accepted 64 MiB per
 * operation. Against a locally measured ~100 ms verification that is roughly 80 verifications per second
 * of throughput, far above what a school-sized login surface needs, while keeping the worst case bounded
 * and modest.
 *
 * Eight is chosen deliberately rather than set to the minimum that would work. The accepted Stage 2.5
 * contract includes "concurrent valid logins are all admitted with distinct sessions", and its suite
 * exercises six at once; a lower bound would refuse legitimate simultaneous sign-ins and would break a
 * guarantee earlier stages established. The bound has to sit **above** the legitimate concurrency of the
 * product it protects, or it becomes the outage. A deployment with more memory headroom can raise it;
 * one with less must lower it and accept the reduced legitimate concurrency.
 *
 * **Not a queue.** Admission is refused immediately rather than waited on, because waiting would hold
 * request bodies and connections in memory for an unbounded time, which is the failure this control
 * exists to prevent.
 */
export const ARGON2ID_CONCURRENCY = Object.freeze({
  /** Simultaneous Argon2id operations permitted across the whole deployment. */
  capacity: 8,
  /**
   * How long a slot may be held before it is reclaimed automatically.
   *
   * A holder that crashes, is killed, or loses its Redis connection releases nothing, so expiry is the
   * backstop that returns its capacity. 30 s is roughly 300x the measured verification time, which
   * makes accidental expiry during healthy operation implausible; an in-flight holder also renews, so
   * the lease only ever has to cover a slow machine or a starved event loop.
   */
  leaseMillis: 30_000,
  /**
   * Renewal interval, deliberately far below the lease. A holder renews while its work runs so a slow
   * operation keeps its slot instead of being reclaimed underneath itself.
   */
  renewIntervalMillis: 10_000,
  /** Upper bound on one Redis round trip for an admission decision. */
  timeoutMillis: 750,
});

/**
 * Meter for the endpoints that must not be spent by an unbounded number of Argon2id verifications.
 *
 * Login always verifies on success and on failure by design (enumeration resistance), and password
 * reset hashes a new password on the success path. Forgot also verifies when it cannot issue.
 */
const VERIFYING_ENDPOINTS: ReadonlySet<AbuseEndpoint> = new Set<AbuseEndpoint>([
  'login',
  'forgot',
  'reset',
]);

/**
 * The complete policy set. Frozen so nothing can mutate enforcement at runtime.
 */
export const AUTH_ABUSE_POLICIES: readonly AbusePolicy[] = Object.freeze([
  Object.freeze({
    endpoint: 'login',
    dimension: 'source',
    capacity: 10,
    windowMillis: 5 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'login',
    dimension: 'target',
    capacity: 8,
    windowMillis: 15 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'forgot',
    dimension: 'source',
    capacity: 5,
    windowMillis: 15 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'forgot',
    dimension: 'target',
    capacity: 3,
    windowMillis: 60 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'reset',
    dimension: 'source',
    capacity: 10,
    windowMillis: 15 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'reset',
    dimension: 'target',
    capacity: 10,
    windowMillis: 15 * 60_000,
    requiresEnforcement: true,
  }),
  // Stage 2.9. A request the controller would reject as malformed performs no Argon2id and is not an
  // authentication attempt, so it is metered on its own cheap per-source bucket instead of on the credential
  // meters or the global budget. Provisional: chosen to be far above what honest clients produce and far below
  // what would make malformed traffic free.
  Object.freeze({
    endpoint: 'login',
    dimension: 'invalid',
    capacity: 30,
    windowMillis: 5 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'forgot',
    dimension: 'invalid',
    capacity: 30,
    windowMillis: 5 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'reset',
    dimension: 'invalid',
    capacity: 30,
    windowMillis: 5 * 60_000,
    requiresEnforcement: true,
  }),
  // Stage 2.9. Successful logins per account. Provisional: 10 per 10 minutes. It bounds how many sessions and
  // `LOGIN_SUCCEEDED` events one account can create and how much of the global Argon2id budget one account can
  // consume, without penalising failures, which have their own meters.
  Object.freeze({
    endpoint: 'login',
    dimension: 'success',
    capacity: 10,
    windowMillis: 10 * 60_000,
    requiresEnforcement: true,
  }),
  Object.freeze({
    endpoint: 'me',
    dimension: 'source',
    capacity: 120,
    windowMillis: 60_000,
    requiresEnforcement: false,
  }),
  Object.freeze({
    endpoint: 'logout',
    dimension: 'source',
    capacity: 30,
    windowMillis: 60_000,
    requiresEnforcement: false,
  }),
]);

/**
 * Resolve the policy for one endpoint and dimension.
 *
 * Returns `null` for a combination that is deliberately unmetered, which is how `me` and `logout`
 * express "source only". Callers treat `null` as "no such meter" rather than as a limit of zero.
 */
export function policyFor(endpoint: AbuseEndpoint, dimension: AbuseDimension): AbusePolicy | null {
  return (
    AUTH_ABUSE_POLICIES.find(
      (policy) => policy.endpoint === endpoint && policy.dimension === dimension,
    ) ?? null
  );
}

/** Whether an endpoint meters the global verification budget. */
export function metersGlobalWorkload(endpoint: AbuseEndpoint): boolean {
  return VERIFYING_ENDPOINTS.has(endpoint);
}

/**
 * Derive a Redis key for one subject.
 *
 * The subject is an HMAC-SHA256 over a domain-separated message, truncated to 32 hex characters
 * (128 bits). Consequences that matter:
 *
 * - A raw email address, recovery token, or session token never appears in a key, in a Redis
 *   `MONITOR` trace, in a keyspace listing, or in a backup. Redis keys are frequently readable by
 *   anyone with operational access, and a recovery token in a key would hand that person a live
 *   password reset.
 * - `endpoint` and `dimension` are part of the message, not the key, so the same subject on two
 *   endpoints produces two unrelated keys and cannot be used to correlate activity across endpoints.
 * - Truncation to 128 bits keeps keys fixed-length. A collision would merge two subjects' budgets;
 *   at 128 bits that needs an intentionally constructed search, and a collision would at worst let
 *   one subject share another's allowance, never to exceed it.
 *
 * The secret is validated at startup and never appears here or in any log.
 */
export function deriveAbuseKey(
  secret: string,
  endpoint: AbuseEndpoint,
  dimension: AbuseDimension,
  subject: string,
): string {
  if (!KEY_COMPONENT.test(endpoint) || !KEY_COMPONENT.test(dimension)) {
    throw new Error('Rate limit key components must be lowercase alphanumeric or hyphen');
  }
  if (typeof subject !== 'string' || subject.length === 0) {
    // Refusing to hash an empty subject would let a caller skip a meter by passing nothing.
    throw new Error('Rate limit subject must be a non-empty string');
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    // A bounded input keeps hashing cost independent of what a caller submitted. Oversized input
    // is truncated to a fixed length rather than rejected, because rejecting would make response
    // timing depend on subject length.
    return buildKey(secret, endpoint, dimension, subject.slice(0, MAX_SUBJECT_LENGTH));
  }
  return buildKey(secret, endpoint, dimension, subject);
}

function buildKey(
  secret: string,
  endpoint: AbuseEndpoint,
  dimension: AbuseDimension,
  subject: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`tsms:auth-abuse:v1:${endpoint}:${dimension}:`)
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${KEY_PREFIX}:${endpoint}:${dimension}:${digest}`;
}

/**
 * The single global verification-workload key.
 *
 * Its subject is a constant, so there is exactly one such key in Redis no matter how many users or
 * instances exist.
 */
export function globalWorkloadKey(secret: string): string {
  return deriveAbuseKey(secret, 'login', 'workload', 'global');
}

/**
 * Turn a policy plus key into a dimension the Redis primitive consumes.
 *
 * `commit` is left to the caller. Deciding it is a policy question - whether a meter counts requests
 * or only failures - so it is stated where the dimensions are built rather than defaulted here.
 */
export function toRateLimitDimension(
  policy: AbusePolicy,
  key: string,
): Omit<RateLimitDimension, 'commit'> {
  return { key, capacity: policy.capacity, windowMillis: policy.windowMillis };
}

/**
 * `Retry-After` is clamped to a bounded range.
 *
 * A lower bound of one second keeps the header well-formed and prevents a hot retry loop; the upper
 * bound stops an attacker from learning the exact size of a remaining window from a long value, and
 * keeps a client from parking on a hint measured in hours. One minute is chosen because every
 * policy window is at least five minutes, so a retry at the clamp is still well inside the window
 * that produced it.
 */
export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Convert a wait into bounded whole seconds.
 *
 * Rounded up: retrying a millisecond early would earn another refusal, which teaches a client to
 * treat the header as a suggestion and retry harder.
 */
export function retryAfterSeconds(retryAfterMillis: number): number {
  if (!Number.isFinite(retryAfterMillis) || retryAfterMillis <= 0) return MIN_RETRY_AFTER_SECONDS;
  const seconds = Math.ceil(retryAfterMillis / 1000);
  return Math.min(Math.max(seconds, MIN_RETRY_AFTER_SECONDS), MAX_RETRY_AFTER_SECONDS);
}
