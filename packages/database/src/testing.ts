/**
 * Safety guard for database integration tests.
 *
 * Integration tests truncate tables and reset migration state. They must never
 * be able to run against an arbitrary database, so the guard is enforced in code
 * rather than left to developer memory or documentation.
 *
 * Rules, all required before a connection is opened:
 *   1. The URL must be a PostgreSQL URL (already validated by @tsms/config).
 *   2. The database name must end with `_test`.
 *   3. The host must be a loopback address or `localhost`.
 *
 * Rejection messages never include the URL, because the URL contains a password.
 */

const REQUIRED_DATABASE_SUFFIX = '_test';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parsePostgresUrl(connectionString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run database integration tests: the test database URL could not be parsed.',
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      'Refusing to run database integration tests: the test database URL must be a PostgreSQL URL.',
    );
  }
  return parsed;
}

/** Return the database name from a PostgreSQL URL. */
export function databaseNameOf(connectionString: string): string {
  return parsePostgresUrl(connectionString).pathname.replace(/^\//, '');
}

/**
 * Assert that `connectionString` is safe to use for destructive integration
 * tests. Returns the same string on success so it can be used inline.
 */
export function assertDisposableTestDatabase(connectionString: string): string {
  const parsed = parsePostgresUrl(connectionString);

  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith(REQUIRED_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run database integration tests: the database name must end with "${REQUIRED_DATABASE_SUFFIX}". No connection was opened.`,
    );
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      'Refusing to run database integration tests: the host must be a loopback address. No connection was opened.',
    );
  }

  return connectionString;
}
