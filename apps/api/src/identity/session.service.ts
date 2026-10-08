import type { PrismaClient } from '@tsms/database';
import { SessionError } from './session-error.js';
import { generateSessionToken, hashSessionToken, SESSION_POLICY } from './session-token.js';

export type SessionClock = () => Date;

function requireId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new SessionError('INVALID_INPUT');
}

function safeFailure(error: unknown): never {
  if (error instanceof SessionError) throw error;
  // No original error/cause: Prisma or crypto diagnostics may contain secrets.
  throw new SessionError('SERVICE_FAILURE');
}

/** Internal primitives only. The caller authorizes creation/revocation.
 * Share the existing process-owned Prisma client with credential/query logging disabled.
 */
export class SessionService {
  constructor(
    private readonly database: PrismaClient,
    private readonly clock: SessionClock = () => new Date(),
  ) {}

  private now(): Date {
    const time = this.clock().getTime();
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15 - SESSION_POLICY.lifetimeMs)
      throw new SessionError('SERVICE_FAILURE');
    return new Date(time);
  }

  async createSession(userId: unknown) {
    requireId(userId);
    try {
      const user = await this.database.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (!user) throw new SessionError('USER_NOT_FOUND');
      if (user.status !== 'ACTIVE') throw new SessionError('USER_DISABLED');
      return await this.insert(this.database, userId);
    } catch (error) {
      return safeFailure(error);
    }
  }

  /**
   * Insert a session using the caller's transaction client - Stage 2.5.
   *
   * The caller must already hold the per-user session-mutation lock on this same transaction, so the
   * insert is ordered against a concurrent password reset rather than racing it. This method performs
   * no status re-read on its own: the caller performs the in-lock revalidation, because the guarantee
   * is only meaningful when the whole sequence shares one transaction and one connection.
   */
  async createSessionInTransaction(tx: { session: PrismaClient['session'] }, userId: unknown) {
    requireId(userId);
    try {
      return await this.insert(tx as unknown as PrismaClient, userId);
    } catch (error) {
      return safeFailure(error);
    }
  }

  /** Shared insert body. `client` is either the base client or a transaction client. */
  private async insert(client: PrismaClient, userId: string) {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_POLICY.lifetimeMs);
    const token = generateSessionToken();
    const session = await client.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        createdAt,
        expiresAt,
        revokedAt: null,
        lastSeenAt: null,
      },
      select: { id: true },
    });
    // Only this creation result returns the bearer secret. No retrievable raw copy exists.
    return { token, sessionId: session.id, expiresAt };
  }

  async validateSession(rawToken: unknown) {
    const tokenHash = hashSessionToken(rawToken);
    try {
      const session = await this.database.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { status: true } },
        },
      });
      if (!session) throw new SessionError('SESSION_NOT_FOUND');
      if (session.revokedAt !== null) throw new SessionError('SESSION_REVOKED');
      // Sample after the read, so time spent waiting on the database cannot extend validity.
      if (this.now().getTime() >= session.expiresAt.getTime())
        throw new SessionError('SESSION_EXPIRED');
      if (!session.user) throw new SessionError('USER_NOT_FOUND');
      if (session.user.status !== 'ACTIVE') throw new SessionError('USER_DISABLED');
      return { userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt };
    } catch (error) {
      return safeFailure(error);
    }
  }

  async revokeSession(sessionId: unknown, expectedUserId: unknown) {
    requireId(sessionId);
    requireId(expectedUserId);
    try {
      const result = await this.database.session.updateMany({
        where: { id: sessionId, userId: expectedUserId, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      if (result.count === 1) return { revoked: true };
      const owned = await this.database.session.findFirst({
        where: { id: sessionId, userId: expectedUserId },
        select: { id: true },
      });
      if (!owned) throw new SessionError('SESSION_NOT_FOUND');
      return { revoked: false }; // Already revoked: keep the original timestamp.
    } catch (error) {
      return safeFailure(error);
    }
  }

  async revokeAllUserSessions(userId: unknown) {
    requireId(userId);
    try {
      const now = this.now();
      const result = await this.database.session.updateMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      return { revokedCount: result.count };
    } catch (error) {
      return safeFailure(error);
    }
  }
}
