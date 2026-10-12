/**
 * Test cleanup for rows that have no owner to look up.
 *
 * A login for an unknown address records a `LOGIN_FAILED` event with `userId = null`, because the identity
 * is genuinely unknown. The per-suite cleanup deletes events by the ids of the users it created, so these
 * rows matched nothing and accumulated in the test database across every run.
 *
 * They cannot be attributed to a suite, so they are deleted wholesale. That is acceptable here and only
 * here: every API integration suite runs against a database whose name and host were verified by
 * `assertDisposableTestDatabase` before the client was created, and the suites run serially
 * (`fileParallelism: false`), so no other suite is mid-test when one of them finishes a test.
 */
export async function clearOrphanSecurityEvents(db) {
  await db.authenticationEvent.deleteMany({ where: { userId: null } });
}
