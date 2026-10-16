/**
 * Safety guard for Redis integration tests.
 *
 * Redis has no schemas, so the equivalent of the database-name guard is the
 * logical database index. Integration tests flush their logical database, so the
 * index must be non-zero. That keeps them away from whatever default database
 * (`0`) an application connection is configured to use.
 *
 * Rejection messages never include the URL, because the URL contains a password.
 */

/** Hosts a destructive test may connect to. Matches the database guard. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseRedisUrl(connectionString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run Redis integration tests: the test Redis URL could not be parsed.',
    );
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      'Refusing to run Redis integration tests: the test Redis URL must be a Redis URL.',
    );
  }
  return parsed;
}

/** Return the logical database index from a Redis URL. */
export function redisDatabaseIndexOf(connectionString: string): number {
  const raw = parseRedisUrl(connectionString).pathname.replace(/^\//, '');
  if (raw === '') {
    return 0;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'Refusing to run Redis integration tests: the logical database must be a numeric index.',
    );
  }
  return Number(raw);
}

/**
 * Assert that `connectionString` is safe for destructive integration tests.
 * Returns the same string on success so it can be used inline.
 */
export function assertDisposableTestRedis(connectionString: string): string {
  if (redisDatabaseIndexOf(connectionString) === 0) {
    throw new Error(
      'Refusing to run Redis integration tests: the test Redis URL must select a non-zero logical database. No connection was opened.',
    );
  }
  // Stage 2.9. The tests delete keys in this database, so it must be on this machine. The database guard has
  // always required the same of PostgreSQL; without it a mistyped `TEST_REDIS_URL` could point at a real Redis.
  if (!LOOPBACK_HOSTS.has(parseRedisUrl(connectionString).hostname)) {
    throw new Error(
      'Refusing to run Redis integration tests: the host must be a loopback address. No connection was opened.',
    );
  }
  return connectionString;
}
