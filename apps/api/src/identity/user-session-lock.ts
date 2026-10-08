import type { PrismaClient } from '@tsms/database';

/**
 * Shared per-user synchronization for session-affecting writes - Stage 2.5.
 *
 * # Why this exists
 *
 * `SessionService.createSession` inserts a session without any coordination, and password reset
 * replaces the credential and revokes sessions inside a transaction. A login that verified the old
 * password could therefore insert its session *after* the reset's revocation statement and keep
 * working on a credential that no longer exists. That is the race this protocol closes.
 *
 * # The protocol
 *
 * Both participants take the same PostgreSQL advisory lock, keyed by a hash of the user id, on the
 * **same transaction client** that performs their writes:
 *
 *   password reset:  lock -> consume token -> replace credential -> supersede -> revoke sessions
 *   login:           lock -> revalidate credential version -> insert session
 *
 * Because the lock key is derived only from the user id, the two paths are mutually exclusive per
 * user and independent across users.
 *
 * # Every session-creating path must participate
 *
 * The lock is *advisory*: it coordinates only writers that take it. Login and password reset are
 * the two paths that exist today, and both take it. **Any future session-creation path must also
 * acquire this lock**, or it can reintroduce the race this protocol closes. The regression suite
 * asserts the login path participates, so a future refactor that bypasses it fails the build rather
 * than silently reopening the hole.
 *
 * The lock is a *transaction-scoped* advisory lock (`pg_advisory_xact_lock`). It is released
 * automatically when the transaction commits or rolls back, so there is no lock leak on the error
 * path. It is deliberately **not** a session-scoped lock: holding one across a separate write would
 * only cover the connection that took it.
 *
 * # Why Argon2id stays outside the lock
 *
 * The login path verifies the password *before* taking the lock, so a 64 MiB, three-iteration
 * allocation never runs while holding it, and concurrent logins for different users are unaffected.
 * The cost is that the credential can change between verification and insertion, which is precisely
 * what the in-lock revalidation step detects.
 *
 * # What this does not do
 *
 * It does not cancel an HTTP request that was already authorized, and it does not revoke a session
 * that a fully committed login created before the reset began - that session is revoked by the
 * reset's own revocation statement, because the two operations cannot interleave.
 */

/**
 * The minimum a transaction client must offer for this protocol.
 *
 * Typed loosely enough to accept both a Prisma interactive-transaction client and the base client:
 * the lock only needs an `$executeRaw` that accepts a tagged template and bound values.
 */
export interface LockableClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * Acquire the per-user session-mutation lock on the caller's transaction client.
 *
 * Must be called with the same client that will perform the protected writes, inside the same
 * transaction. Calling it on a different connection provides no protection whatsoever.
 *
 * `hashtextextended` gives a stable 64-bit key for the user id, so the lock is derived from database
 * state rather than from process memory: two API instances, two containers, or two connections agree
 * on the same lock without any coordination between them. A process-local mutex would not.
 */
export async function lockUserSessionMutations(tx: LockableClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
}

/** True when `tx` is a Prisma interactive-transaction client rather than the base client. */
export function isTransactionClient(tx: unknown): tx is LockableClient & PrismaClient {
  return typeof (tx as LockableClient | null | undefined)?.$executeRaw === 'function';
}
