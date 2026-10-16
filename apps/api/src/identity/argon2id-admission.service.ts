/**
 * Argon2id slot admission - Stage 2.6 hardening.
 *
 * Wraps the two accepted services so that **every** Argon2id allocation - real verification, decoy
 * burn, and credential hashing - is bracketed by one deployment-wide slot.
 *
 * ## Why this lives outside the rate limiter
 *
 * The rate limiter answers "how much work may be asked for". This answers "how much may run at once".
 * Keeping them separate matters because they have different failure semantics: a full bucket is a
 * *refusal to this caller* (`429`), while a full semaphore is a *capacity condition* shared by everyone
 * and is reported distinctly so it can never be mistaken for an account-level judgement.
 *
 * ## Why wrapping here is complete
 *
 * Every Argon2id call reachable from HTTP passes through one of:
 *
 *   AuthService.login          -> verifyCredentialVersioned, or burnVerification for an unknown address
 *   PasswordRecoveryService    -> burnVerification for an ineligible request, hashPassword on reset
 *
 * Both are wrapped. A new call site added later without this wrapper would silently escape the bound,
 * so `assertArgon2idAdmission` is exported for a regression test that fails if a service stops being
 * wrapped rather than relying on review to notice.
 *
 * ## What a caller sees
 *
 * - Slot refused: the request is refused **before** any Argon2id runs. No session, no token, no write.
 * - Admission unavailable (Redis unreachable, timed out, or an unreadable reply): also refused before
 *   any Argon2id. There is no unlimited fallback and no local-only bypass.
 *
 * Both refusals surface as the existing sanitized `503`, because neither reveals anything about the
 * caller and neither should be distinguishable from another service failure.
 */

import {
  Argon2idAdmissionUnavailableError,
  acquireArgon2idSlot,
  argon2idHolders,
  releaseArgon2idSlot,
  renewArgon2idSlot,
  type Redis,
} from '@tsms/redis';
import { randomBytes } from 'node:crypto';
import { ARGON2ID_CONCURRENCY } from './auth-abuse-policy.js';
import type { MeterOutcome } from './meter-outcome.js';

/**
 * The deployment-wide budget on Argon2id operations *started* - Stage 2.9.
 *
 * Charged here, at the one place every Argon2id operation is admitted, and nowhere else. A request that performs
 * no Argon2id - a malformed body, an origin refusal, an eligible recovery request - therefore never spends it,
 * and a request that does spend it spends exactly once, whatever the route that led here.
 */
export interface Argon2idWorkloadBudget {
  charge(): Promise<MeterOutcome>;
}

/**
 * Refusal reasons, kept separate so neither can be mistaken for an authentication outcome.
 *
 * A refused slot and an unconfirmable slot both stop the work, but they mean different things: the
 * first is saturation, the second is an unknown bound. They are kept as distinct values so a future
 * operator-facing metric can tell them apart without either becoming visible to a client.
 */
export type Argon2idRefusal = 'saturated' | 'unavailable' | 'budget';

export class Argon2idAdmissionRefused extends Error {
  constructor(
    readonly refusal: Argon2idRefusal,
    readonly held: number,
    /** Set only for `budget`: the bounded wait before the global Argon2id budget has a token again. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Argon2id admission refused: ${refusal}`);
    this.name = 'Argon2idAdmissionRefused';
  }
}

/** A held slot, plus the idempotent release the caller must run in a `finally`. */
export interface Argon2idPermit {
  release(): Promise<void>;
}

export interface Argon2idAdmissionOptions {
  readonly capacity: number;
  readonly leaseMillis: number;
  readonly renewIntervalMillis: number;
  readonly timeoutMillis: number;
}

const DEFAULT_OPTIONS: Argon2idAdmissionOptions = ARGON2ID_CONCURRENCY;

/**
 * Admission control for the deployment-wide Argon2id bound.
 *
 * One instance per process, sharing the process-owned Redis client.
 */
export class Argon2idAdmissionService {
  /**
   * Renewal timers, keyed by holder.
   *
   * Held here rather than in the permit so that a holder which is renewed and then released has its
   * timer cleared deterministically; a leaked interval would keep the event loop alive and would keep
   * renewing a slot nobody holds.
   */
  private readonly renewals = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly redis: Redis,
    /**
     * Stage 2.9. Required, not optional: an admission service without the workload budget would silently stop
     * bounding Argon2id work started per window.
     */
    private readonly workload: Argon2idWorkloadBudget,
    private readonly options: Argon2idAdmissionOptions = DEFAULT_OPTIONS,
  ) {}

  /**
   * Take one slot, or refuse.
   *
   * @throws {Argon2idAdmissionRefused} when the deployment is saturated or the bound is unconfirmable.
   */
  async acquire(): Promise<Argon2idPermit> {
    // 32 random bytes, base64url. Never derived from a credential, address, or token, so a holder id
    // discloses nothing and cannot be predicted to interfere with another request's slot.
    const holder = randomBytes(32).toString('base64url');

    let decision;
    try {
      decision = await acquireArgon2idSlot(this.redis, holder, {
        limit: this.options.capacity,
        leaseMillis: this.options.leaseMillis,
        timeoutMillis: this.options.timeoutMillis,
      });
    } catch (error) {
      if (error instanceof Argon2idAdmissionUnavailableError) {
        throw new Argon2idAdmissionRefused('unavailable', 0);
      }
      throw error;
    }

    if (!decision.acquired) throw new Argon2idAdmissionRefused('saturated', decision.held);

    // Stage 2.9. Charge the global budget now, before any hashing, and only because hashing is about to start.
    // The slot is already held, so the charge is not spent on a request the semaphore would have refused, and it
    // is the single charge for this operation. Any outcome other than `charged` releases the slot and refuses
    // before Argon2id runs; an unexpected error releases it too, so capacity cannot leak.
    let charge: MeterOutcome;
    try {
      charge = await this.workload.charge();
    } catch (error) {
      await this.release(holder);
      throw error;
    }
    if (charge.kind !== 'charged') {
      await this.release(holder);
      throw charge.kind === 'limited'
        ? new Argon2idAdmissionRefused('budget', decision.held, charge.retryAfterSeconds)
        : new Argon2idAdmissionRefused('unavailable', decision.held);
    }

    this.startRenewal(holder);
    return { release: () => this.release(holder) };
  }

  /** Extend the lease while work continues, so a slow operation is not reclaimed underneath itself. */
  private startRenewal(holder: string): void {
    const timer = setInterval(() => {
      void renewArgon2idSlot(this.redis, holder, {
        limit: this.options.capacity,
        leaseMillis: this.options.leaseMillis,
        timeoutMillis: this.options.timeoutMillis,
      });
    }, this.options.renewIntervalMillis);
    // Never hold the process open for a renewal.
    timer.unref();
    this.renewals.set(holder, timer);
  }

  /**
   * Return the slot.
   *
   * Idempotent by construction: the release script only removes a member that is present, so a
   * duplicated call, a call after the lease already expired, or a call racing its own renewal are all
   * no-ops. It can never release another request's slot.
   */
  private async release(holder: string): Promise<void> {
    const timer = this.renewals.get(holder);
    if (timer !== undefined) {
      clearInterval(timer);
      this.renewals.delete(holder);
    }
    await releaseArgon2idSlot(this.redis, holder, { timeoutMillis: this.options.timeoutMillis });
  }

  /** Current holder count across the deployment. Exposed for tests and operational inspection. */
  async held(): Promise<number> {
    return argon2idHolders(this.redis);
  }
}

/**
 * Run `work` while holding one slot.
 *
 * This is the only supported way to perform Argon2id work in the identity layer. The slot is released
 * in `finally`, so a thrown error or an early return cannot leak capacity.
 */
export async function withArgon2idSlot<T>(
  admission: Argon2idAdmissionService,
  work: () => Promise<T>,
): Promise<T> {
  const permit = await admission.acquire();
  try {
    return await work();
  } finally {
    await permit.release();
  }
}
