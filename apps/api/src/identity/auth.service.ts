import type { PrismaClient } from '@tsms/database';
import { fingerprintOf } from './password-credential.service.js';
import { verifyPassword, type PasswordVerification } from './password-hasher.js';
import { validatePassword } from './password-policy.js';
import {
  Argon2idAdmissionService,
  Argon2idAdmissionRefused,
  withArgon2idSlot,
} from './argon2id-admission.service.js';
import type { MeterOutcome } from './meter-outcome.js';
import { SessionService } from './session.service.js';
import { SessionError } from './session-error.js';
import { lockUserSessionMutations } from './user-session-lock.js';
import type { SecurityEventRecorder } from './security-event-recorder.js';
import type { SecurityLog } from './security-log.js';

export type AuthErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_REQUEST'
  | 'SERVICE_FAILURE'
  /**
   * Every unusable recovery token - unknown, expired, consumed, superseded, or belonging to a
   * disabled account - collapses to this one code. Stage 2.5.
   */
  | 'RECOVERY_TOKEN_INVALID'
  /** The submitted new password violates the accepted Stage 2.2 policy. Stage 2.5. */
  | 'INVALID_PASSWORD'
  /**
   * An abuse-protection meter refused the request. Stage 2.6.
   *
   * Raised only after enforcement succeeded and declined, never because enforcement was unavailable -
   * an unconfirmable meter fails closed through `SERVICE_FAILURE` instead, so this code cannot be
   * used to distinguish "you are limited" from "protection is down".
   */
  | 'RATE_LIMITED';

/**
 * The only error this layer raises. HTTP translation lives in the exception filter, so the
 * service never has to know about statuses, and the filter never has to know about credentials.
 */
export class AuthError extends Error {
  /**
   * `retryAfterSeconds` is set only for a refusal raised **after** admission - the global Argon2id budget or the
   * per-account success meter declining inside the handler. It lets the exception filter send `Retry-After`, and
   * lets the reservation interceptor return the reservation, because nothing was attempted.
   */
  constructor(
    readonly code: AuthErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'AuthError';
  }
}

export type { MeterOutcome };

/**
 * Per-account budget for successful logins - Stage 2.9.
 *
 * Charged only after the password has verified and before a session exists, so a refused success creates no
 * session and no `LOGIN_SUCCEEDED` event. It is returned if session creation then fails, so only a login that
 * actually produced a session spends it. Failed attempts never touch it.
 */
export interface LoginSuccessMeter {
  charge(normalizedEmail: string): Promise<MeterOutcome>;
  refund(normalizedEmail: string): Promise<void>;
}

/** The one Argon2id verification a login performs. A parameter so a test can count calls deterministically. */
export type PasswordVerifier = (
  candidate: unknown,
  encoded: string,
) => Promise<PasswordVerification>;

/**
 * A fixed Argon2id digest with the production parameters (64 MiB, t=3, p=1), generated from a
 * random 32-byte string that is not stored anywhere.
 *
 * Its only purpose is to make a failed login cost what a successful one costs. It corresponds to
 * no account, and no password can be recovered from it. Keeping it here rather than deriving it at
 * runtime avoids paying the 64 MiB allocation on every process start.
 */
const DECOY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$UqspmdtHfxgzbg2DRFxx4g$yhKYAZ++CRXyEvwC/OYssfsiEM+/x4Do67M2baPhDo4';

/** Longest address accepted after trimming. RFC 5321 caps a forward path at 256 octets. */
export const MAX_EMAIL_LENGTH = 320;
// eslint-disable-next-line no-control-regex -- matching C0 and DEL literally is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Normalize an address for `User.normalizedEmail` lookup.
 *
 * Trim surrounding whitespace and lowercase, and do nothing else. No plus-address stripping, no
 * dot removal, no Unicode normalisation: the column documents exactly this rule, and widening it
 * would merge addresses the identity model deliberately keeps distinct. Returns `null` for a value
 * that is not a usable address at all.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  // A control character has no place in an address and would be a log-injection vector.
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** The only identity fields this stage is allowed to return. */
export interface PublicUserProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

const profileFields = { id: true, email: true, displayName: true } as const;

export interface LoginResult {
  readonly user: PublicUserProfile;
  /** The single raw copy of the bearer secret. Transport only; never persisted, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * HTTP-agnostic authentication orchestration for global identity.
 *
 * It owns the order of operations and nothing else: credential verification stays in the accepted
 * Stage 2.2 service, token lifecycle stays in the accepted Stage 2.3 service, and this stage adds
 * no authorization, no school or tenant context, and no user creation.
 */
export class AuthService {
  constructor(
    private readonly database: PrismaClient,
    private readonly sessions: SessionService,
    /**
     * Deployment-wide Argon2id admission - Stage 2.6 hardening.
     *
     * Required rather than optional: every verification on this path, including the decoy burn for an
     * unknown address, allocates 64 MiB, so leaving it out would silently remove the bound on
     * simultaneous verification. `login` is therefore the one place that cannot be served without it.
     */
    private readonly argon2id: Argon2idAdmissionService,
    /**
     * Stage 2.7. Required rather than optional, for the same reason as `argon2id`: a recorder that is
     * absent must not degrade into "no security events are written", because a clean event table and a
     * broken one look identical from outside.
     */
    private readonly events: SecurityEventRecorder,
    private readonly securityLog: SecurityLog,
    /**
     * Stage 2.9. Required, like the services above: a login without the success meter would silently be
     * unbounded again.
     */
    private readonly successMeter: LoginSuccessMeter,
    private readonly clock: () => Date = () => new Date(),
    private readonly verify: PasswordVerifier = verifyPassword,
  ) {}

  /**
   * Record a refused sign-in.
   *
   * `userId` is the account the attempt resolved to, or `null` when the address matched nothing. The
   * distinction is deliberate and stays internal: it is what makes a credential-stuffing run against one
   * account visible, and it is never returned to the caller, so it creates no enumeration oracle.
   *
   * Best-effort by construction - the recorder's detached path cannot throw - because the request has
   * already failed and turning a lost audit row into a different status code would itself leak.
   */
  private async recordLoginFailure(userId: string | null, requestId?: string): Promise<void> {
    await this.events.detached({
      eventType: 'LOGIN_FAILED',
      userId,
      requestId,
    });
  }

  /**
   * Authenticate a submitted address and password, then create a session.
   *
   * Every failure - unknown address, wrong password, no credential record, disabled account -
   * raises the same `AUTHENTICATION_FAILED`, so the caller cannot distinguish them.
   */
  async login(email: unknown, password: unknown, requestId?: string): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === null || typeof password !== 'string') {
      // Deliberately not recorded as a failed login: a malformed body is a rejected request, not an
      // authentication attempt, and an attacker can generate those at will without ever attempting to
      // authenticate. Recording them would inflate the event table with attempts that were never made.
      throw new AuthError('INVALID_REQUEST');
    }

    // One slot covers the whole verification, including the decoy path.
    //
    // Stage 2.9 inspection. A candidate that fails the password policy is rejected by the verifier before Argon2id
    // runs, on the real-digest path and the decoy path alike. It therefore needs no slot and must not spend the
    // global Argon2id budget, which measures hashing actually started. Charging it would let a flood of well-formed
    // logins with a short password drain the budget without ever hashing. Everything else about the attempt -
    // the lookup, the failure record, the generic refusal - is identical, so nothing distinguishes the cases.
    const hashes = validatePassword(password).valid;
    const attempt = () => this.verifyAndCreateSession(normalizedEmail, password, requestId);
    try {
      return hashes ? await withArgon2idSlot(this.argon2id, attempt) : await attempt();
    } catch (error) {
      // Stage 2.6 hardening. The deployment is at its simultaneous-verification bound, or the bound
      // could not be confirmed. Either way no Argon2id is attempted and no session is created. The
      // caller maps this to the same sanitized `503` as any other service failure, so it is
      // indistinguishable from an infrastructure problem - which is what it is.
      if (error instanceof Argon2idAdmissionRefused) {
        if (error.refusal === 'budget') {
          // Stage 2.9. The deployment-wide Argon2id budget declined at the moment the work would have started.
          // No Argon2id ran and nothing was written. It is the same `429` the guard answers with.
          this.securityLog.record('auth_rate_limited', {
            endpoint: 'login',
            requestId,
            reason: 'rate_limited',
          });
          throw new AuthError('RATE_LIMITED', error.retryAfterSeconds);
        }
        this.securityLog.record('argon2id_admission_refused', {
          endpoint: 'login',
          requestId,
          reason: 'argon2id_unavailable',
        });
        throw new AuthError('SERVICE_FAILURE');
      }
      throw error;
    }
  }

  /**
   * The accepted Stage 2.4 and Stage 2.5 verification, bracketed by one Argon2id slot.
   *
   * Stage 2.9. Every path performs exactly one Argon2id verification, so the cost of a refusal does not depend on
   * whether the address belongs to an account:
   *
   * - one read returns the user and, when there is one, its credential;
   * - one verification then runs against the real digest when the account is active and has a credential, and
   *   against the fixed decoy digest otherwise;
   * - the result is only believed when it was a verification against the real digest.
   *
   * The earlier version verified against the real digest and, on a mismatch, verified again against the decoy,
   * so an existing account with a wrong password cost twice what an unknown address cost. That doubling is
   * what the account-existence timing oracle was made of.
   *
   * The credential version and digest fingerprint come from the same read as the digest that was verified, so the
   * in-lock revalidation below still compares against exactly what the password was checked against.
   */
  private async verifyAndCreateSession(
    normalizedEmail: string,
    password: string,
    requestId?: string,
  ): Promise<LoginResult> {
    const user = await this.database.user.findUnique({
      where: { normalizedEmail },
      select: {
        ...profileFields,
        status: true,
        passwordCredential: { select: { passwordHash: true, passwordChangedAt: true } },
      },
    });

    const credential = user !== null && user.status === 'ACTIVE' ? user.passwordCredential : null;

    let outcome: PasswordVerification;
    try {
      outcome = await this.verify(password, credential?.passwordHash ?? DECOY_PASSWORD_HASH);
    } catch {
      // A storage or native failure is operational, and is the same on the decoy path as on the real one, so it
      // cannot separate an existing account from an unknown address either.
      throw new AuthError('SERVICE_FAILURE');
    }

    if (user === null || credential === null || !outcome.matches) {
      // Unknown address, disabled account, no credential record, or a wrong password. The one verification above
      // already paid the real cost.
      await this.recordLoginFailure(user?.id ?? null, requestId);
      throw new AuthError('AUTHENTICATION_FAILED');
    }

    const verified = {
      version: credential.passwordChangedAt.getTime(),
      fingerprint: fingerprintOf(credential.passwordHash),
    };

    // Stage 2.9. The per-account success budget is consumed here: after the password is known to be correct and
    // before any session exists. A refusal therefore creates no session and no `LOGIN_SUCCEEDED` event.
    const charge = await this.successMeter.charge(normalizedEmail);
    if (charge.kind === 'limited') {
      this.securityLog.record('auth_rate_limited', {
        endpoint: 'login',
        requestId,
        reason: 'rate_limited',
      });
      throw new AuthError('RATE_LIMITED', charge.retryAfterSeconds);
    }
    if (charge.kind === 'unavailable') {
      this.securityLog.record('auth_enforcement_unavailable', {
        endpoint: 'login',
        requestId,
        reason: 'redis_unavailable',
      });
      throw new AuthError('SERVICE_FAILURE');
    }

    try {
      return await this.createSessionUnderLock(user, verified, requestId);
    } catch (error) {
      // No session was issued, so the success budget is returned: only a login that produced a session spends it.
      await this.successMeter.refund(normalizedEmail);
      throw error;
    }
  }

  /**
   * Insert the session while holding the per-user session-mutation lock.
   *
   * Stage 2.5. Password verification already happened, and deliberately outside this transaction so
   * the 64 MiB Argon2id allocation never runs while the lock is held. The consequence is that a
   * password reset could replace the credential in between, which would leave this login about to
   * authorise a session using a password that no longer exists.
   *
   * So the lock is taken on this transaction, the credential version observed at verification time is
   * re-read under it, and a changed version aborts with the same generic failure a wrong password
   * produces. The reset takes the identical lock, so the two are strictly ordered:
   *
   *   login commits first  -> the reset revokes the session it just created
   *   reset commits first  -> the login sees the advanced version and refuses to insert
   *
   * The lock is a transaction-scoped advisory lock, released automatically on commit or rollback,
   * and it is taken on the same client that performs the insert.
   */
  private async createSessionUnderLock(
    user: { id: string; email: string; displayName: string },
    verified: { version: number; fingerprint: string },
    requestId?: string,
  ): Promise<LoginResult> {
    try {
      const created = await this.database.$transaction(async (tx) => {
        await lockUserSessionMutations(tx, user.id);

        // In-lock revalidation: the account must still be usable, and the credential must be the
        // exact state the password was verified against.
        //
        // Both signals are compared. `passwordChangedAt` catches ordinary replacements, and the
        // digest fingerprint is authoritative: a credential row replaced with a different digest but
        // a recycled timestamp would pass a timestamp-only check, which is why it is not trusted
        // alone. The digest itself is never read here, only a one-way hash of it.
        const current = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            status: true,
            id: true,
            email: true,
            displayName: true,
            passwordCredential: {
              select: { passwordHash: true, passwordChangedAt: true },
            },
          },
        });
        if (current === null || current.status !== 'ACTIVE') {
          throw new AuthError('AUTHENTICATION_FAILED');
        }
        const credential = current.passwordCredential;
        if (
          credential === null ||
          credential.passwordChangedAt.getTime() !== verified.version ||
          fingerprintOf(credential.passwordHash) !== verified.fingerprint
        ) {
          // The credential changed after this password was verified, so the verification no longer
          // proves anything. Indistinguishable from a wrong password to the caller.
          throw new AuthError('AUTHENTICATION_FAILED');
        }

        const created = await this.sessions.createSessionInTransaction(tx, user.id);

        // Stage 2.7. Written on this transaction, after the session insert, so the two commit or roll
        // back together. A LOGIN_SUCCEEDED row can therefore never outlive a rolled-back session, and a
        // committed session can never be missing its audit record. This is the only place a login is
        // declared successful, which is why it is here and not in the handler.
        await this.events.inTransaction(tx, {
          eventType: 'LOGIN_SUCCEEDED',
          userId: user.id,
          requestId,
        });

        return created;
      });

      return {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        ...created,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        // Stage 2.7. The in-lock revalidation refusals above roll this transaction back, so the success
        // event written inside it is already gone. Record the refusal here, where the decision is final.
        if (error.code === 'AUTHENTICATION_FAILED') {
          await this.recordLoginFailure(user.id, requestId);
        }
        throw error;
      }
      if (error instanceof SessionError) {
        if (
          error.code === 'USER_DISABLED' ||
          error.code === 'USER_NOT_FOUND' ||
          error.code === 'INVALID_INPUT'
        ) {
          // The session primitive refused the account (for example disabled after the in-lock check).
          // The caller sees the same 401 as any refusal, so it is recorded as one.
          await this.recordLoginFailure(user.id, requestId);
          throw new AuthError('AUTHENTICATION_FAILED');
        }
        throw new AuthError('SERVICE_FAILURE');
      }
      throw new AuthError('SERVICE_FAILURE');
    }
  }

  /**
   * Resolve the global profile behind an already-presented session token.
   *
   * Absent, malformed, unknown, expired, revoked, and disabled-account all collapse to one
   * failure. Credential rows, session identifiers, digests, and school context are never returned.
   */
  async currentUser(token: unknown): Promise<PublicUserProfile> {
    const session = await this.resolve(token);
    const user = await this.database.user.findUnique({
      where: { id: session.userId },
      select: profileFields,
    });
    if (user === null) throw new AuthError('AUTHENTICATION_FAILED');
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  /**
   * Revoke the session named by the presented token, and nothing else.
   *
   * Idempotent by design: a token that is already invalid, expired, revoked, or unrecognised is
   * simply finished. The caller cannot tell the difference, so the response reveals nothing about
   * whether the token ever existed. Only this session is revoked, so a user's other sessions and
   * other users' sessions are untouched.
   */
  async logout(token: unknown, requestId?: string): Promise<void> {
    let session: { userId: string; sessionId: string; expiresAt: Date };
    try {
      session = await this.resolve(token);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'AUTHENTICATION_FAILED') {
        // Deliberately no event. A logout with no valid session ends nothing, and recording one would let
        // anyone generate unlimited `LOGOUT` rows by calling this endpoint in a loop.
        return;
      }
      throw error;
    }
    try {
      // Stage 2.7. Revocation and its event share one transaction, so `LOGOUT` can never exist for a
      // session that was not actually revoked. Only the token's own session is revoked, and only when it
      // was still live - an already-revoked session keeps its original timestamp and produces no event,
      // which is what keeps logout idempotent.
      await this.database.$transaction(async (tx) => {
        const result = await this.sessions.revokeSessionInTransaction(
          tx,
          session.sessionId,
          session.userId,
        );
        if (result.revoked) {
          await this.events.inTransaction(tx, {
            eventType: 'LOGOUT',
            userId: session.userId,
            requestId,
          });
        }
      });
    } catch (error) {
      // A session removed between validation and revocation is already revoked.
      if (
        error instanceof SessionError &&
        (error.code === 'SESSION_NOT_FOUND' || error.code === 'INVALID_INPUT')
      ) {
        return;
      }
      throw new AuthError('SERVICE_FAILURE');
    }
  }

  /** Validate a token through the accepted session primitive, normalising the failure taxonomy. */
  private async resolve(
    token: unknown,
  ): Promise<{ userId: string; sessionId: string; expiresAt: Date }> {
    try {
      return await this.sessions.validateSession(token);
    } catch (error) {
      if (error instanceof SessionError && error.code === 'SERVICE_FAILURE') {
        throw new AuthError('SERVICE_FAILURE');
      }
      // INVALID_TOKEN, SESSION_NOT_FOUND, SESSION_EXPIRED, SESSION_REVOKED, USER_NOT_FOUND and
      // USER_DISABLED are all the same externally visible outcome.
      throw new AuthError('AUTHENTICATION_FAILED');
    }
  }
}
