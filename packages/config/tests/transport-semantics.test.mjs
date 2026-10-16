import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '../dist/env.js';

/**
 * Stage 2.9 (F-06): the production transport rules are checked against the behaviour of the client libraries that
 * are actually installed, not against a belief about what their settings mean.
 *
 * The rule "a URL is accepted only if it guarantees a verified connection" is only as good as the libraries'
 * interpretation of that URL, and that interpretation has changed between versions (`sslmode=require` meant
 * "verify" and is being redefined to mean "do not verify"). So for a matrix of URLs this file asks both sides:
 * does the validator accept it, and does the real library configure certificate AND hostname verification for it?
 * The invariant is accepted => verified. If a library upgrade changes a meaning, this fails instead of the
 * production rule silently becoming a weaker one.
 */

const here = (path) => new URL(path, import.meta.url);
const requireFrom = (path) => createRequire(here(path));

// `pg-connection-string` is a dependency of `pg`, which is a dependency of the database package.
const databaseRequire = requireFrom('../../database/package.json');
const { parse: parsePostgresUrl } = createRequire(databaseRequire.resolve('pg'))(
  'pg-connection-string',
);
const { Redis } = requireFrom('../../redis/package.json')('ioredis');

const production = {
  NODE_ENV: 'production',
  API_HOST: '10.20.30.40',
  API_PORT: '4000',
  DATABASE_URL:
    'postgresql://app:Zq8mV2xKp4Rt7NwBdG5h@db.internal.test:5432/tsms?sslmode=verify-full',
  REDIS_URL: 'rediss://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6380',
  API_TRUSTED_ORIGINS: 'https://app.tsms.test',
  API_RATE_LIMIT_HMAC_SECRET: 'K7xQm2pR9vTb4nL6wYcZ8aD3fH5jS1gN0eU7iO2pA4yV6',
};

const accepts = (overrides) => {
  try {
    parseApiEnvironment({ ...production, ...overrides });
    return true;
  } catch {
    return false;
  }
};

/** True when the library will verify the server certificate chain and hostname for this connection. */
function postgresVerifies(url) {
  const { ssl } = parsePostgresUrl(url);
  if (!ssl) return false; // plaintext (or left to a PGSSLMODE environment variable)
  if (ssl === true) return true; // `tls.connect` defaults: chain and hostname verified
  if (ssl.rejectUnauthorized === false) return false;
  if (typeof ssl.checkServerIdentity === 'function') return false; // hostname check replaced
  return true;
}

// `pg-connection-string` reads `sslrootcert` while parsing, so the file has to exist. Its content is irrelevant.
const caFile = join(mkdtempSync(join(tmpdir(), 'tsms-transport-')), 'ca.pem');
writeFileSync(caFile, 'not a real certificate');
const caParameter = `sslrootcert=${encodeURIComponent(caFile)}`;

const base = 'postgresql://app:Zq8mV2xKp4Rt7NwBdG5h@db.internal.test:5432/tsms';
const postgresUrls = [
  base,
  `${base}?sslmode=disable`,
  `${base}?sslmode=allow`,
  `${base}?sslmode=prefer`,
  `${base}?sslmode=require`,
  `${base}?sslmode=verify-ca`,
  `${base}?sslmode=verify-full`,
  `${base}?sslmode=no-verify`,
  `${base}?sslmode=require&uselibpqcompat=true`,
  `${base}?sslmode=prefer&uselibpqcompat=true`,
  `${base}?sslmode=verify-ca&uselibpqcompat=true&${caParameter}`,
  `${base}?sslmode=verify-full&uselibpqcompat=true`,
  `${base}?sslmode=verify-full&uselibpqcompat=false`,
  `${base}?sslmode=verify-full&ssl=false`,
  `${base}?sslmode=verify-full&SSLMODE=disable`,
  `${base}?ssl=true`,
  `${base}?ssl=1`,
  `${base}?ssl=0`,
];

describe('PostgreSQL: every URL the validator accepts is verified by the installed driver', () => {
  it.each(postgresUrls)('%s', (url) => {
    const accepted = accepts({ DATABASE_URL: url });
    if (accepted) expect(postgresVerifies(url)).toBe(true);
  });

  it('accepts at least verify-full, so the check is not vacuous', () => {
    expect(accepts({ DATABASE_URL: `${base}?sslmode=verify-full` })).toBe(true);
    expect(postgresVerifies(`${base}?sslmode=verify-full`)).toBe(true);
  });

  it('documents the library behaviour the rule depends on', () => {
    // These are the facts the validator is written against. If a library upgrade changes one of them, this
    // test names the fact that moved.
    expect(postgresVerifies(base)).toBe(false);
    expect(postgresVerifies(`${base}?sslmode=no-verify`)).toBe(false);
    expect(postgresVerifies(`${base}?sslmode=require&uselibpqcompat=true`)).toBe(false);
    expect(postgresVerifies(`${base}?sslmode=verify-ca&uselibpqcompat=true&${caParameter}`)).toBe(
      false,
    );
    expect(postgresVerifies(`${base}?sslmode=verify-full`)).toBe(true);
  });
});

describe('Redis: every URL the validator accepts enables TLS with default verification', () => {
  const redisUrls = [
    'redis://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6379',
    'rediss://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6380',
    'rediss://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6380?tls=false',
    'rediss://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6380/1',
  ];

  /** Build the client without connecting, and read the TLS options it computed from the URL. */
  function tlsOptionsOf(url) {
    const client = new Redis(url, { lazyConnect: true });
    try {
      return client.options.tls;
    } finally {
      client.disconnect();
    }
  }

  it.each(redisUrls)('%s', (url) => {
    const accepted = accepts({ REDIS_URL: url });
    if (!accepted) return;
    const tls = tlsOptionsOf(url);
    // ioredis represents a plain `rediss:` URL as `tls: true`, which `tls.connect` treats as its defaults
    // (certificate chain and hostname verified). An options object is acceptable only if it relaxes nothing.
    expect(tls).toBeTruthy();
    if (typeof tls === 'object') {
      expect(tls.rejectUnauthorized).not.toBe(false);
      expect(typeof tls.checkServerIdentity).not.toBe('function');
    }
  });

  it('documents the library behaviour the rule depends on', () => {
    expect(tlsOptionsOf('redis://:x@redis.internal.test:6379')).toBeUndefined();
    const secure = tlsOptionsOf('rediss://:x@redis.internal.test:6380');
    expect(secure).toBeTruthy();
    expect(secure.rejectUnauthorized).not.toBe(false);
  });

  it('accepts the rediss: URL without a query, so the check is not vacuous', () => {
    expect(accepts({ REDIS_URL: redisUrls[1] })).toBe(true);
    expect(accepts({ REDIS_URL: redisUrls[2] })).toBe(false);
  });
});
