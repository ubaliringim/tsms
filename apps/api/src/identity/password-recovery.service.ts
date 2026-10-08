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
  async requestRecovery(email: unknown): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail === null) {
      // Not even a candidate address. Still pay the verification cost so a malformed address is not
      // distinguishable from a well-formed unknown one by duration alone.
      await this.burnVerification();
      return;
    }

    if (!deliveryAvailable(this.settings.mode)) {
      // Fail closed before any write: no token, no row, no email attempt.
      throw new AuthError('SERVICE_FAILURE');
    }

    const user = await this.database.user.findUnique({
      where: { normalizedEmail },
      select: profileFields,
    });

    if (user === null || user.status !== 'ACTIVE') {
      await this.burnVerification();
      return;
    }

    let eligible = false;
    try {
      // Presence of a credential is an eligibility condition, not an authentication one.
      eligible =
        (await this.database.passwordCredential.count({ where: { userId: user.id } })) === 1;
    } catch {
      throw new AuthError('SERVICE_FAILURE');
    }
    if (!eligible) {
      await this.burnVerification();
      return;
    }

    const token = generateRecoveryToken();
    const tokenHash = hashRecoveryToken(token);
    if (tokenHash === null) throw new AuthError('SERVICE_FAILURE');
    const issuedAt = this.now();
    const expiresAt = recoveryExpiry(issuedAt);

    try {
      // Issuing supersedes every earlier outstanding token for this user, so only the newest link
      // works and an attacker cannot accumulate valid links.
      await this.database.$transaction([
        this.database.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: issuedAt },
        }),
        this.database.passwordResetToken.create({
          data: { userId: user.id, tokenHash, createdAt: issuedAt, expiresAt },
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
   * Redeem a recovery token and replace the password.
   *
   * Every unusable token - unknown, expired, consumed, superseded, or malformed - raises the same
   * generic failure. A successful reset does not create a session.
   */
  async resetPassword(token: unknown, newPassword: unknown): Promise<void> {
    if (!isRecoveryToken(token)) throw new AuthError('RECOVERY_TOKEN_INVALID');
    const tokenHash = hashRecoveryToken(token);
    if (tokenHash === null) throw new AuthError('RECOVERY_TOKEN_INVALID');

    // Validate the token before the password, so a policy rejection can never disclose token
    // validity and a policy error can never disclose account existence.
    const claimed = await this.claimToken(tokenHash);
    if (claimed === null) throw new AuthError('RECOVERY_TOKEN_INVALID');

    // Hash outside the transaction: the transaction must never hold a connection across a 64 MiB
    // allocation. Nothing is written yet, so losing the race after this point is harmless.
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(newPassword);
    } catch {
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

        // Revoke every live session. Inside the same transaction as the credential change, so a
        // reset reliably evicts sessions that existed when it committed.
        await tx.session.updateMany({
          where: { userId: claimed.userId, revokedAt: null, expiresAt: { gt: this.now() } },
          data: { revokedAt: this.now() },
        });
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('SERVICE_FAILURE');
    }
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
}
