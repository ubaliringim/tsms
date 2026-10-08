import { createHash } from 'node:crypto';
import { type PrismaClient } from '@tsms/database';
import { PasswordCredentialError } from './password-error.js';
import { hashPassword, verifyPassword } from './password-hasher.js';

/**
 * One-way fingerprint of a stored Argon2id digest.
 *
 * Stage 2.5 compares this under the advisory lock to detect that the credential changed between
 * password verification and session insertion. Hashing the digest keeps the credential itself out of
 * the comparison and out of any variable that could be logged.
 */
export function fingerprintOf(passwordHash: string): string {
  return createHash('sha256').update(passwordHash, 'utf8').digest('hex');
}

const publicFields = { id: true, userId: true, passwordChangedAt: true } as const;

function persistenceError(error: unknown): never {
  if (error instanceof PasswordCredentialError) throw error;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'P2002') throw new PasswordCredentialError('CREDENTIAL_EXISTS');
    if (error.code === 'P2003') throw new PasswordCredentialError('USER_NOT_FOUND');
  }
  throw new PasswordCredentialError('PERSISTENCE_FAILURE');
}

/** Internal credential primitive. Caller must authorize provisioning/replacement.
 * No HTTP wiring, session checks, events, or recovery orchestration here.
 * Use the process-owned client with logging disabled, as configured by DatabaseService.
 */
export class PasswordCredentialService {
  constructor(private readonly database: PrismaClient) {}

  async createPasswordCredential(userId: string, candidate: unknown) {
    const passwordHash = await hashPassword(candidate);
    try {
      // The FK checks existence atomically; uniqueness handles concurrent creation.
      return await this.database.passwordCredential.create({
        data: { userId, passwordHash },
        select: publicFields,
      });
    } catch (error) {
      return persistenceError(error);
    }
  }

  async verifyCredential(userId: string, candidate: unknown) {
    try {
      const credential = await this.database.passwordCredential.findUnique({
        where: { userId },
        select: { passwordHash: true },
      });
      if (!credential) throw new PasswordCredentialError('CREDENTIAL_NOT_FOUND');
      return await verifyPassword(candidate, credential.passwordHash);
    } catch (error) {
      return persistenceError(error);
    }
  }

  /**
   * Verify a candidate and report the credential state it was verified against.
   *
   * Stage 2.5 needs this because a password reset can replace the credential between the moment a
   * login verifies the password and the moment that login inserts its session. The caller carries
   * `version` and `fingerprint` forward and re-checks both inside the protected transaction, so a
   * verification against superseded credential state is rejected rather than used.
   *
   * Two signals are returned because neither is sufficient alone:
   *
   * - `version` is `passwordChangedAt`. Replacements advance it strictly, so it catches the ordinary
   *   case. It is millisecond resolution (PostgreSQL `timestamp(3)` and JavaScript `Date` agree),
   *   so nothing is truncated - but a *replacement row* can legitimately reuse a value, so it cannot
   *   be treated as a unique version counter.
   * - `fingerprint` is SHA-256 over the stored digest. Any change to the credential changes it. This
   *   is the authoritative signal.
   *
   * The digest itself is never returned. `fingerprint` is a one-way hash of it, so holding it in
   * memory for an in-lock comparison cannot leak the credential, and it is never logged.
   */
  async verifyCredentialVersioned(userId: string, candidate: unknown) {
    try {
      const credential = await this.database.passwordCredential.findUnique({
        where: { userId },
        select: { passwordHash: true, passwordChangedAt: true },
      });
      if (!credential) throw new PasswordCredentialError('CREDENTIAL_NOT_FOUND');
      const verification = await verifyPassword(candidate, credential.passwordHash);
      return {
        verification,
        version: credential.passwordChangedAt.getTime(),
        fingerprint: fingerprintOf(credential.passwordHash),
      };
    } catch (error) {
      return persistenceError(error);
    }
  }

  async changePassword(userId: string, candidate: unknown) {
    try {
      const previous = await this.database.passwordCredential.findUnique({ where: { userId } });
      if (!previous) throw new PasswordCredentialError('CREDENTIAL_NOT_FOUND');
      // Hash outside a transaction; compare-and-swap rejects overlapping replacements.
      const passwordHash = await hashPassword(candidate);
      const passwordChangedAt = new Date(
        Math.max(Date.now(), previous.passwordChangedAt.getTime() + 1),
      );
      const result = await this.database.passwordCredential.updateMany({
        where: {
          id: previous.id,
          passwordHash: previous.passwordHash,
          passwordChangedAt: previous.passwordChangedAt,
        },
        data: { passwordHash, passwordChangedAt },
      });
      if (result.count !== 1) throw new PasswordCredentialError('CONCURRENT_CHANGE');
      return { id: previous.id, userId, passwordChangedAt };
    } catch (error) {
      return persistenceError(error);
    }
  }
}
