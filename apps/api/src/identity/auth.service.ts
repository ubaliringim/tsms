import type { PrismaClient } from '@tsms/database';
import { PasswordCredentialService, fingerprintOf } from './password-credential.service.js';
import { PasswordCredentialError } from './password-error.js';
import { verifyPassword } from './password-hasher.js';
import { SessionService } from './session.service.js';
import { SessionError } from './session-error.js';
import { lockUserSessionMutations } from './user-session-lock.js';

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
  | 'INVALID_PASSWORD';

/**
 * The only error this layer raises. HTTP translation lives in the exception filter, so the
 * service never has to know about statuses, and the filter never has to know about credentials.
 */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
  }
}

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
    private readonly credentials: PasswordCredentialService,
    private readonly sessions: SessionService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Authenticate a submitted address and password, then create a session.
   *
   * Every failure - unknown address, wrong password, no credential record, disabled account -
   * raises the same `AUTHENTICATION_FAILED`, so the caller cannot distinguish them.
   */
  async login(email: unknown, password: unknown): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === null || typeof password !== 'string') {
      throw new AuthError('INVALID_REQUEST');
    }

    const user = await this.database.user.findUnique({
      where: { normalizedEmail },
      select: { ...profileFields, status: true },
    });

    let verified: { matches: boolean; version: number; fingerprint: string } | null = null;
    if (user !== null && user.status === 'ACTIVE') {
      try {
        const outcome = await this.credentials.verifyCredentialVersioned(user.id, password);
        if (outcome.verification.matches) {
          verified = {
            matches: true,
            version: outcome.version,
            fingerprint: outcome.fingerprint,
          };
        }
      } catch (error) {
        // A missing credential is an authentication outcome. Anything else - a storage or
        // driver failure - is operational and must stay distinguishable from "wrong password".
        if (!(error instanceof PasswordCredentialError) || error.code !== 'CREDENTIAL_NOT_FOUND') {
          throw new AuthError('SERVICE_FAILURE');
        }
      }
    }

    if (verified === null || user === null) {
      // Unknown address, disabled account, or no credential record. Pay the real verification
      // cost anyway so duration does not become an account-existence oracle.
      await this.burnVerification(password);
      throw new AuthError('AUTHENTICATION_FAILED');
    }

    return this.createSessionUnderLock(user, verified);
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

        return await this.sessions.createSessionInTransaction(tx, user.id);
      });

      return {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        ...created,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof SessionError) {
        if (
          error.code === 'USER_DISABLED' ||
          error.code === 'USER_NOT_FOUND' ||
          error.code === 'INVALID_INPUT'
        ) {
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
  async logout(token: unknown): Promise<void> {
    let session: { userId: string; sessionId: string; expiresAt: Date };
    try {
      session = await this.resolve(token);
    } catch (error) {
      if (error instanceof AuthError && error.code === 'AUTHENTICATION_FAILED') return;
      throw error;
    }
    try {
      await this.sessions.revokeSession(session.sessionId, session.userId);
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

  /**
   * Spend a real Argon2id verification against the decoy digest.
   *
   * Failures are ignored: the caller is already rejecting the login, and this path exists only to
   * equalise cost.
   */
  private async burnVerification(candidate: unknown): Promise<void> {
    try {
      await verifyPassword(candidate, DECOY_PASSWORD_HASH);
    } catch {
      // Nothing to disclose and nothing to do.
    }
  }
}
