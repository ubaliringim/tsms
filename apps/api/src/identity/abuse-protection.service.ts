/**
 * Abuse-protection orchestration - Stage 2.6.
 *
 * The guard asks one question - may this request proceed? - and this module answers it by building
 * every dimension the request should be metered on, enforcing them atomically, and classifying the
 * result as **allowed**, **limited**, or **unavailable**.
 *
 * The three outcomes are deliberately distinct because they are not interchangeable for the caller:
 *
 * - `allowed` - proceed.
 * - `limited` - refuse with `429`. Enforcement worked and said no.
 * - `unavailable` - Redis could not confirm enforcement. For a fail-closed endpoint this refuses
 *   with `503` *without* attempting Argon2id or issuing a recovery token. For `me` and `logout` it
 *   proceeds, because neither spends the expensive operation and refusing would trade a throttle for
 *   an outage.
 *
 * ## `me` and `logout` under an outage
 *
 * These two carry `requiresEnforcement: false`, so a Redis outage costs them a throttle rather than
 * the endpoint. Neither performs Argon2id, so no resource-exhaustion protection is lost.
 *
 * Logout is safe to let through because **session revocation does not depend on Redis**. Revocation
 * is a PostgreSQL write in the accepted Stage 2.3 service; Redis only ever provided the throttle. So
 * an outage leaves revocation fully functional, the browser cookie is still cleared, and the `204`
 * remains a truthful claim: the session really was revoked. Refusing the request instead would mean a
 * browser unable to log out during a Redis incident, and reporting success while skipping revocation
 * would mean telling a user a stolen session is dead when it is not. Neither happens: revocation runs,
 * and a genuine revocation failure surfaces through the accepted `SERVICE_FAILURE` path exactly as it
 * did in Stage 2.4.
 *
 * ## Requests versus failures
 *
 * Whether an endpoint meters every request or only failed attempts is decided by
 * {@link countsEveryRequest}, which lives beside the policy. The distinction is not cosmetic:
 * a failure-metered `forgot` would limit nothing, because the abuse it exists to stop - email
 * flooding - consists of requests that *succeed*.
 *
 * ## What is charged
 *
 * Dimensions are built for the endpoint's source and, where a policy defines one, its target. The
 * target subject is derived from the normalised account address (or the recovery token digest), so it
 * is identical for an existing account and a nonexistent one. That is what keeps the limit from
 * becoming an account-existence oracle: nothing in this path ever asks the database whether an account
 * exists.
 *
 * All dimensions for one decision go into a single script invocation, so a request is either charged
 * on every dimension or on none.
 */

import {
  RateLimitUnavailableError,
  consumeRateLimit,
  refundRateLimit,
  type RateLimitDimension,
  type Redis,
} from '@tsms/redis';
import {
  GLOBAL_ARGON2ID_BUDGET,
  countsEveryRequest,
  deriveAbuseKey,
  globalWorkloadKey,
  metersGlobalWorkload,
  policyFor,
  retryAfterSeconds,
  toRateLimitDimension,
  type AbuseEndpoint,
} from './auth-abuse-policy.js';
import { hashRecoveryToken } from './password-recovery-token.js';

export type AbuseDecisionKind = 'allowed' | 'limited' | 'unavailable';

export interface AbuseDecision {
  readonly kind: AbuseDecisionKind;
  /** Whole seconds, already clamped. Zero when allowed or unavailable. */
  readonly retryAfterSeconds: number;
  /** True when the endpoint's own policy allows it to run without confirmed enforcement. */
  readonly proceeds: boolean;
}

const ALLOWED: AbuseDecision = Object.freeze({
  kind: 'allowed',
  retryAfterSeconds: 0,
  proceeds: true,
});

/** What the caller knows about itself, never anything derived from a request header. */
export interface AbuseRequestContext {
  /** Canonical transport peer address, or `unknown`. */
  readonly clientAddress: string;
  /** Normalised account address for account-oriented limits. Never a raw submission. */
  readonly normalizedEmail: string | null;
  /** Submitted recovery token, hashed before it can reach a key. */
  readonly recoveryToken?: string | undefined;
}

/**
 * The subject for the endpoint's target dimension.
 *
 * For login and forgot that is the normalised address, so the key is derived from the same string
 * whether or not the account exists - no database lookup happens here, and no existence signal can
 * enter the key.
 *
 * For reset it is the SHA-256 digest of the submitted token. A raw token never becomes key material:
 * a recovery token is a live password reset, and Redis keys are readable by anyone with operational
 * access. Hashing is what the token is compared by everywhere else too, so no new material is
 * introduced. A malformed token still yields a stable subject, so token-guessing attempts are metered
 * rather than falling through unmetered.
 */
function targetSubject(endpoint: AbuseEndpoint, context: AbuseRequestContext): string | null {
  if (endpoint === 'reset') {
    const digest = hashRecoveryToken(context.recoveryToken);
    // A token that is not canonical cannot be redeemed, so it gets the same bounded treatment as any
    // other unusable submission rather than an unlimited path.
    return digest ?? 'malformed-recovery-token';
  }
  return context.normalizedEmail;
}

/** Build the source dimension, or `null` when the endpoint has no source policy. */
function sourceDimension(
  secret: string,
  endpoint: AbuseEndpoint,
  context: AbuseRequestContext,
  commit: boolean,
): RateLimitDimension | null {
  const policy = policyFor(endpoint, 'source');
  if (policy === null) return null;
  return {
    ...toRateLimitDimension(
      policy,
      deriveAbuseKey(secret, endpoint, 'source', context.clientAddress),
    ),
    commit,
  };
}

/** Build the target dimension, or `null` when there is no policy or no usable subject. */
function targetDimension(
  secret: string,
  endpoint: AbuseEndpoint,
  context: AbuseRequestContext,
  commit: boolean,
): RateLimitDimension | null {
  const policy = policyFor(endpoint, 'target');
  if (policy === null) return null;
  const subject = targetSubject(endpoint, context);
  if (subject === null) return null;
  return {
    ...toRateLimitDimension(policy, deriveAbuseKey(secret, endpoint, 'target', subject)),
    commit,
  };
}

/**
 * Build the dimensions consulted before the handler runs.
 *
 * For a **request-metered** endpoint these are `commit: true`, so admission spends the budget: the
 * meter bounds how many requests are served, which is exactly the threat for flooding.
 *
 * For a **failure-metered** endpoint these are `commit: false`, so admission only inspects and the
 * charge follows the outcome in {@link AbuseProtectionService.recordFailure}. That is what lets a
 * legitimate success cost nothing.
 *
 * The global verification budget is `commit: true` on every endpoint either way. It is the hard bound
 * on Argon2id work and is spent unconditionally, because an existing and a nonexistent account both
 * verify on every login by design.
 *
 * Exported so the composition can be asserted directly, without Redis, and so a policy change that
 * adds or drops a dimension is visible as a failing test rather than as a silently weaker control.
 */
export function dimensionsFor(
  secret: string,
  endpoint: AbuseEndpoint,
  context: AbuseRequestContext,
): RateLimitDimension[] {
  // Stage 2.6 hardening. Admission now **reserves** on every endpoint, including the failure-metered
  // ones.
  //
  // Reserving unconditionally is what closes the concurrency bypass. A check that writes nothing lets
  // every simultaneous request read the same untouched bucket, so N concurrent failures all pass an
  // allowance of 8 and all reach Argon2id. A reservation makes them genuinely contend for the same
  // tokens, and the token bucket's atomicity bounds the burst to the configured capacity.
  //
  // Legitimate fairness is preserved by refunding: {@link AbuseProtectionService.refundFor} returns
  // the reservation whenever the attempt was not an authentication failure, so a correct sign-in still
  // costs nothing while a burst of failures stays bounded.
  const dimensions = [
    sourceDimension(secret, endpoint, context, true),
    targetDimension(secret, endpoint, context, true),
  ].filter((dimension): dimension is RateLimitDimension => dimension !== null);

  if (metersGlobalWorkload(endpoint)) {
    dimensions.push({
      ...toRateLimitDimension(
        { endpoint, dimension: 'workload', ...GLOBAL_ARGON2ID_BUDGET, requiresEnforcement: true },
        globalWorkloadKey(secret),
      ),
      commit: true,
    });
  }

  return dimensions;
}

/**
 * Build the credential dimensions whose reservation is returned for a non-abuse outcome.
 *
 * Only the credential meters: the global verification budget was already spent before the handler ran,
 * and it deliberately measures work *started*, so it is never refunded. A token bucket that hands back
 * its own admission control would be self-defeating.
 *
 * Empty for request-metered endpoints, whose meters are final and must not be refunded - returning those
 * tokens would let a caller keep `forgot` unbounded by interleaving.
 */
export function refundableDimensionsFor(
  secret: string,
  endpoint: AbuseEndpoint,
  context: AbuseRequestContext,
): RateLimitDimension[] {
  if (countsEveryRequest(endpoint)) return [];
  return [
    sourceDimension(secret, endpoint, context, true),
    targetDimension(secret, endpoint, context, true),
  ].filter((dimension): dimension is RateLimitDimension => dimension !== null);
}

export interface AbuseProtectionOptions {
  /** Already-validated HMAC secret from startup configuration. */
  readonly secret: string;
  readonly redis: Redis;
  readonly timeoutMillis?: number;
}

/**
 * Decide whether one authentication request may proceed.
 *
 * Never throws for an operational Redis problem: an unavailable enforcement layer is a decision the
 * caller makes per endpoint, not an exception that escapes into a generic handler. Configuration
 * faults still throw, because they are programming errors rather than runtime conditions.
 */
export class AbuseProtectionService {
  constructor(private readonly options: AbuseProtectionOptions) {}

  private enforce(dimensions: RateLimitDimension[]) {
    return consumeRateLimit(this.options.redis, dimensions, {
      ...(this.options.timeoutMillis === undefined
        ? {}
        : { timeoutMillis: this.options.timeoutMillis }),
    });
  }

  async decide(endpoint: AbuseEndpoint, context: AbuseRequestContext): Promise<AbuseDecision> {
    const dimensions = dimensionsFor(this.options.secret, endpoint, context);
    if (dimensions.length === 0) return ALLOWED;

    let verdict;
    try {
      verdict = await this.enforce(dimensions);
    } catch (error) {
      if (!(error instanceof RateLimitUnavailableError)) throw error;
      return this.unavailable(endpoint);
    }

    if (!verdict.allowed) {
      return {
        kind: 'limited',
        retryAfterSeconds: retryAfterSeconds(verdict.retryAfterMillis),
        proceeds: false,
      };
    }
    return ALLOWED;
  }

  /**
   * Return the reservation for an attempt that was not abuse.
   *
   * **This is what makes "a legitimate success is free" an enforced property.** Admission reserves a
   * token on every failure-metered dimension so that concurrent requests genuinely contend; this method
   * hands the reservation back whenever the attempt turned out to be legitimate, so:
   *
   * - a correct sign-in, a malformed request, an untrusted origin, and an operational failure all keep
   *   no charge;
   * - a wrong password or an unusable recovery token **keeps** its reservation;
   * - and the burst limit still holds, because the refund happens only after the outcome is known and
   *   the reservation was taken atomically in the first place.
   *
   * Failures are swallowed. The response has already been produced, and a lost refund costs this
   * caller one unit of its own allowance - far better than turning an ordinary wrong password into a
   * `503`, which is both wrong and a way to distinguish outcomes.
   */
  async refundFor(endpoint: AbuseEndpoint, context: AbuseRequestContext): Promise<void> {
    const dimensions = refundableDimensionsFor(this.options.secret, endpoint, context);
    if (dimensions.length === 0) return;
    try {
      await refundRateLimit(this.options.redis, dimensions, {
        ...(this.options.timeoutMillis === undefined
          ? {}
          : { timeoutMillis: this.options.timeoutMillis }),
      });
    } catch {
      // Deliberately swallowed. See the comment above.
    }
  }

  /**
   * Apply the endpoint's outage policy.
   *
   * A fail-closed endpoint refuses with `503`, so no Argon2id is attempted and no recovery token is
   * issued while enforcement is unconfirmed. `me` and `logout` proceed: neither spends the expensive
   * operation, and logout's revocation does not depend on Redis.
   */
  private unavailable(endpoint: AbuseEndpoint): AbuseDecision {
    const policy = policyFor(endpoint, 'source');
    if (policy?.requiresEnforcement === true) {
      return { kind: 'unavailable', retryAfterSeconds: 0, proceeds: false };
    }
    return { kind: 'unavailable', retryAfterSeconds: 0, proceeds: true };
  }
}
