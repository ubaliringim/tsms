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
  return connectionString;
}
