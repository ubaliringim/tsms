import { type PrismaClient } from '@tsms/database';
import { PasswordCredentialError } from './password-error.js';
import { hashPassword, verifyPassword } from './password-hasher.js';

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
