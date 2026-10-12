import type { PrismaClient } from '@tsms/database';
import { AuthError } from './auth.service.js';
import { normalizeEmail } from './auth.service.js';
import { verifyPassword } from './password-hasher.js';
import { hashPassword } from './password-hasher.js';
import {
  buildRecoveryUrl,
  generateRecoveryToken,
  hashRecoveryToken,
  isRecoveryToken,
  recoveryExpiry,
} from './password-recovery-token.js';
import {
  deliveryAvailable,
  type PasswordRecoveryDelivery,
  type RecoveryInstructions,
} from './password-recovery-delivery.js';
import { lockUserSessionMutations } from './user-session-lock.js';
import { securityEventRow, type SecurityEventRecorder } from './security-event-recorder.js';
import type { SecurityLog } from './security-log.js';
import {
  Argon2idAdmissionService,
  Argon2idAdmissionRefused,
  withArgon2idSlot,
} from './argon2id-admission.service.js';

/**
 * A fixed Argon2id digest with the production parameters, shared with the Stage 2.4 login path so
 * both ineligible cases cost the same as a real verification. It corresponds to no account.
 */
const DECOY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$UqspmdtHfxgzbg2DRFxx4g$yhKYAZ++CRXyEvwC/OYssfsiEM+/x4Do67M2baPhDo4';

const profileFields = { id: true, email: true, displayName: true, status: true } as const;

export interface RecoveryPolicySettings {
  readonly mode: 'disabled' | 'development-only';
  readonly urlBase: string;
}

/**
 * The minimal recipient record eligibility resolution returns.
 *
 * Deliberately the three fields delivery needs and nothing else: no `status`, no credential row, no
 * normalised address. Returning a narrower shape than the query selects keeps it obvious that no
 * additional account state is retained on this path.
 */
interface RecoveryRecipient {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * HTTP-agnostic password recovery for existing global users - Stage 2.5.
 *
 * Reuses the accepted Stage 2.2 Argon2id hasher and the accepted `PasswordResetToken` model. It adds
 * no account creation, no authorization, and no session issuance: a successful reset requires the
 * user to log in again.
 */
export class PasswordRecoveryService {
  constructor(
    private readonly database: PrismaClient,
    private readonly delivery: PasswordRecoveryDelivery,
    private readonly settings: RecoveryPolicySettings,
    /**
     * Deployment-wide Argon2id admission - Stage 2.6 hardening.
     *
     * Required rather than optional. `burnVerification` and `hashPassword` both allocate 64 MiB, and
     * both are reachable here, so a service constructed without admission would serve unbounded
     * simultaneous Argon2id work. Every such call below goes through it.
     */
    private readonly argon2id: Argon2idAdmissionService,
    /**
     * Stage 2.7. Required, not optional: a recovery service without an event recorder would issue
     * tokens and change passwords with no audit trail, and would look exactly like one that is quiet.
     */
    private readonly events: SecurityEventRecorder,
    private readonly securityLog: SecurityLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): Date {
    return new Date(this.clock().getTime());
  }

  /**
   * Issue a recovery token for an eligible account.
   *
   * Every outcome - eligible, unknown address, disabled account, missing credential, delivery
   * failure - resolves without raising, because the caller must answer `202` identically in all of
   * them. Only an operational failure of the service itself surfaces, and it surfaces as the same
   * closed response the disabled mode uses, so it cannot become an oracle either.
   */
  async requestRecovery(email: unknown, requestId?: string): Promise<void> {
    // Stage 2.6 hardening. The eligibility decision is made first, because it decides whether any
    // Argon2id happens at all; only the ineligible branches take a slot. A slot is not reserved for an
    // eligible request, so a legitimate recovery never competes for verification capacity.
    const normalizedEmail = normalizeEmail(email);
    const resolved = await this.resolveEligibility(normalizedEmail);

    if (!resolved.eligible) {
      // Not a candidate address, unknown, disabled, or no credential. Each of these pays a real
      // verification so none is distinguishable by duration alone.
      await this.guarded(() => this.burnVerification(), 'forgot', requestId);
      // Stage 2.7. No event on this branch, and that is load-bearing rather than an omission: recording
      // anything here would turn "we issued a token" into a readable difference between eligible and
      // ineligible requests. Eligibility is observable only through the delivery inbox, as it must be.
      return;
    }
    const { user } = resolved;

    const token = generateRecoveryToken();
    const tokenHash = hashRecoveryToken(token);
    if (tokenHash === null) throw new AuthError('SERVICE_FAILURE');
    const issuedAt = this.now();
    const expiresAt = recoveryExpiry(issuedAt);

    try {
      // Issuing supersedes every earlier outstanding token for this user, so only the newest link
      // works and an attacker cannot accumulate valid links.
      //
      // Stage 2.7. The event is the third statement in this batch, so the token and its audit record
      // commit together. A recovery request that rolls back leaves no row claiming a token was issued.
      await this.database.$transaction([
        this.database.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: issuedAt },
        }),
        this.database.passwordResetToken.create({
          data: { userId: user.id, tokenHash, createdAt: issuedAt, expiresAt },
          select: { id: true },
        }),
        // Built by the recorder's own row function, so this write passes the same closed-vocabulary and
        // UUID checks as every other event even though it has to be a batch member.
        this.database.authenticationEvent.create({
          data: securityEventRow({
            eventType: 'PASSWORD_RESET_REQUESTED',
            userId: user.id,
            requestId,
          }),
          select: { id: true },
        }),
      ]);
    } catch {
      throw new AuthError('SERVICE_FAILURE');
    }

    const instructions: RecoveryInstructions = {
      recipient: user.email,
      displayName: user.displayName,
      token,
      resetUrl: buildRecoveryUrl(this.settings.urlBase, token),
      expiresAt,
    };
    try {
      await this.delivery.sendRecoveryInstructions(instructions);
    } catch {
      // Delivery failure is deliberately swallowed: the response must not reveal it. The token row
      // remains valid and unusable without the link, so this fails safe rather than open.
    }
  }

  /**
   * Decide whether this request can issue a token, without performing any Argon2id work.
   *
   * Returns `false` for a malformed address, an unknown address, a disabled account, and a missing
   * credential - the four cases that must still cost a verification. Returns `false` immediately when
   * delivery is disabled, because that path fails closed before any write and therefore must not spend
   * a verification either.
   */
  private async resolveEligibility(
    normalizedEmail: string | null,
  ): Promise<{ eligible: false } | { eligible: true; user: RecoveryRecipient }> {
    if (normalizedEmail === null) return { eligible: false };

    if (!deliveryAvailable(this.settings.mode)) {
      // Fail closed before any write and before any Argon2id: no token, no row, no email attempt.
      throw new AuthError('SERVICE_FAILURE');
    }

    const user = await this.database.user.findUnique({
      where: { normalizedEmail },
      select: profileFields,
    });

    if (user === null || user.status !== 'ACTIVE') return { eligible: false };

    try {
      // Presence of a credential is an eligibility condition, not an authentication one.
      const hasCredential =
        (await this.database.passwordCredential.count({ where: { userId: user.id } })) === 1;
      return hasCredential
        ? {
            eligible: true,
            user: { id: user.id, email: user.email, displayName: user.displayName },
          }
        : { eligible: false };
    } catch {
      throw new AuthError('SERVICE_FAILURE');
    }
  }

  /**
   * Redeem a recovery token and replace the password.
   *
   * Every unusable token - unknown, expired, consumed, superseded, or malformed - raises the same
   * generic failure. A successful reset does not create a session.
   */
  async resetPassword(token: unknown, newPassword: unknown, requestId?: string): Promise<void> {
    if (!isRecoveryToken(token)) {
      this.recordTokenRejection(requestId);
      throw new AuthError('RECOVERY_TOKEN_INVALID');
    }
    const tokenHash = hashRecoveryToken(token);
    if (tokenHash === null) {
      this.recordTokenRejection(requestId);
      throw new AuthError('RECOVERY_TOKEN_INVALID');
    }

    // Validate the token before the password, so a policy rejection can never disclose token
    // validity and a policy error can never disclose account existence.
    const claimed = await this.claimToken(tokenHash);
    if (claimed === null) {
      this.recordTokenRejection(requestId);
      throw new AuthError('RECOVERY_TOKEN_INVALID');
    }

    // Hash outside the transaction: the transaction must never hold a connection across a 64 MiB
    // allocation. Nothing is written yet, so losing the race after this point is harmless.
    //
    // Stage 2.6 hardening: the hash takes a deployment-wide Argon2id slot, so simultaneous resets
    // cannot each allocate 64 MiB. The slot is released before the transaction opens, which preserves
    // the accepted property that no connection is ever held across an allocation.
    let passwordHash: string;
    try {
      passwordHash = await this.guarded(() => hashPassword(newPassword), 'reset', requestId);
    } catch (error) {
      // An admission refusal is an operational outcome and must not be reported as a policy violation:
      // the two are distinguishable to the client, and conflating them would both mislead the user and
      // disclose that no hashing was attempted.
      if (error instanceof AuthError) throw error;
      // The accepted hasher rejects a policy-invalid candidate. That is a safe validation error and
      // carries no account information. The token is left unconsumed so the user can retry.
      throw new AuthError('INVALID_PASSWORD');
    }

    try {
      await this.database.$transaction(async (tx) => {
        // Per-user advisory lock: serialises concurrent resets for this user without a schema
        // change and without blocking any other user. Released at commit or rollback. The same
        // helper the login path uses, so the two key derivations cannot drift apart.
        await lockUserSessionMutations(tx, claimed.userId);

        // Re-check eligibility under the lock. A user disabled after claiming the token gets no
        // new password.
        const user = await tx.user.findUnique({
          where: { id: claimed.userId },
          select: { status: true },
        });
        if (user === null || user.status !== 'ACTIVE') {
          throw new AuthError('RECOVERY_TOKEN_INVALID');
        }

        // Consume conditionally. Exactly one caller can match an unused, unexpired row, so a replay
        // or a second concurrent redemption affects zero rows and aborts the whole transaction.
        const consumed = await tx.passwordResetToken.updateMany({
          where: {
            tokenHash,
            usedAt: null,
            expiresAt: { gt: this.now() },
          },
          data: { usedAt: this.now() },
        });
        if (consumed.count !== 1) throw new AuthError('RECOVERY_TOKEN_INVALID');

        const credential = await tx.passwordCredential.findUnique({
          where: { userId: claimed.userId },
          select: { id: true, passwordHash: true, passwordChangedAt: true },
        });
        if (credential === null) throw new AuthError('RECOVERY_TOKEN_INVALID');

        // Compare-and-swap on the digest and timestamp rejects an overlapping replacement.
        const replaced = await tx.passwordCredential.updateMany({
          where: {
            id: credential.id,
            passwordHash: credential.passwordHash,
            passwordChangedAt: credential.passwordChangedAt,
          },
          data: {
            passwordHash,
            passwordChangedAt: new Date(
              Math.max(Date.now(), credential.passwordChangedAt.getTime() + 1),
            ),
          },
        });
        if (replaced.count !== 1) throw new AuthError('RECOVERY_TOKEN_INVALID');

        // Supersede any other outstanding token for this user.
        await tx.passwordResetToken.updateMany({
          where: { userId: claimed.userId, usedAt: null },
          data: { usedAt: this.now() },
        });

        // Revoke every live session and record one `SESSION_REVOKED` per session revoked, in one
        // set-based statement on this transaction. See `revokeLiveSessionsRecordingEvents` for why the
        // events are derived from the update's own rows and why no count is read beforehand.
        await this.events.revokeLiveSessionsRecordingEvents(tx, {
          userId: claimed.userId,
          revokedAt: this.now(),
          requestId,
        });

        // Stage 2.7. Written on the transaction that performed the change, so `PASSWORD_RESET_COMPLETED`
        // cannot survive a rollback and cannot exist without the credential replacement it describes.
        await this.events.inTransaction(tx, {
          eventType: 'PASSWORD_RESET_COMPLETED',
          userId: claimed.userId,
          requestId,
        });
      });
    } catch (error) {
      if (error instanceof AuthError) {
        // The token was claimable a moment ago and lost the race, or its owner was disabled meanwhile.
        if (error.code === 'RECOVERY_TOKEN_INVALID') this.recordTokenRejection(requestId);
        throw error;
      }
      throw new AuthError('SERVICE_FAILURE');
    }
  }

  /**
   * Note a rejected recovery token in the operational security log.
   *
   * Deliberately not an `AuthenticationEvent`. An unknown token has no user to attribute it to, so the
   * row would carry `userId = null` and say nothing; worse, an attacker can present a different bogus
   * token every time, and the per-token rate meter would not bound the total. A log line with no
   * identifying field is both smaller and genuinely useful.
   *
   * The token itself is never passed to the log: the log has no field that could hold one.
   */
  private recordTokenRejection(requestId?: string): void {
    this.securityLog.record('recovery_token_rejected', {
      endpoint: 'reset',
      requestId,
      reason: 'token_rejected',
    });
  }

  /**
   * Look up an unexpired, unused token and return its owner.
   *
   * This is a read, not the authoritative check: the conditional update inside the transaction is
   * what actually decides who may redeem. Reading first keeps an unusable token from ever paying for
   * an Argon2id operation.
   */
  private async claimToken(tokenHash: string): Promise<{ userId: string } | null> {
    try {
      const row = await this.database.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { userId: true, usedAt: true, expiresAt: true },
      });
      if (row === null || row.usedAt !== null) return null;
      if (this.now().getTime() >= row.expiresAt.getTime()) return null;
      return { userId: row.userId };
    } catch {
      throw new AuthError('SERVICE_FAILURE');
    }
  }

  /** Spend a real Argon2id verification so an ineligible request costs what an eligible one costs. */
  private async burnVerification(): Promise<void> {
    try {
      await verifyPassword('ineligible-recovery-placeholder', DECOY_PASSWORD_HASH);
    } catch {
      // Nothing to disclose and nothing to do.
    }
  }

  /**
   * Run Argon2id work while holding one deployment-wide slot.
   *
   * A refusal means the bound could not be honoured or could not be confirmed, so the work must not
   * proceed. It surfaces as `SERVICE_FAILURE`, which is both sanitized and indistinguishable from any
   * other operational failure - and it is raised before any allocation, so no work was half-done.
   */
  private async guarded<T>(
    work: () => Promise<T>,
    endpoint: string,
    requestId?: string,
  ): Promise<T> {
    try {
      return await withArgon2idSlot(this.argon2id, work);
    } catch (error) {
      if (error instanceof Argon2idAdmissionRefused) {
        this.securityLog.record('argon2id_admission_refused', {
          endpoint,
          requestId,
          reason: 'argon2id_unavailable',
        });
        throw new AuthError('SERVICE_FAILURE');
      }
      throw error;
    }
  }
}
