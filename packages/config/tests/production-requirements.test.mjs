import { describe, expect, it } from 'vitest';
import { parseApiEnvironment, parseWorkerEnvironment } from '../dist/env.js';

/**
 * Stage 2.9 (F-06): production configuration fails closed.
 *
 * Every rule here applies only when NODE_ENV=production. The development and test modes keep working with the
 * local fixtures, and that is asserted too, so a stricter production cannot silently break local development or CI.
 *
 * Every fixture below is synthetic. The strings that stand in for secrets are distinctive so each rejection test
 * can assert the value never appears in the error message.
 */

const GOOD_DB_PASSWORD = 'Zq8mV2xKp4Rt7NwBdG5h';
const GOOD_REDIS_PASSWORD = 'Yw5nC9sLd3Fh6JpAeT1u';
const GOOD_SECRET = 'K7xQm2pR9vTb4nL6wYcZ8aD3fH5jS1gN0eU7iO2pA4yV6';

const production = {
  NODE_ENV: 'production',
  API_HOST: '10.20.30.40',
  API_PORT: '4000',
  DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=verify-full`,
  REDIS_URL: `rediss://:${GOOD_REDIS_PASSWORD}@redis.internal.test:6380`,
  API_TRUSTED_ORIGINS: 'https://app.tsms.test',
  API_RATE_LIMIT_HMAC_SECRET: GOOD_SECRET,
};

const developmentFixtures = {
  API_HOST: undefined,
  DATABASE_URL: 'postgresql://tsms:tsms_local_development@127.0.0.1:5432/tsms',
  REDIS_URL: 'redis://:tsms_local_redis@127.0.0.1:6379',
  API_TRUSTED_ORIGINS: 'http://127.0.0.1:3000,http://127.0.0.1:3001',
  API_RATE_LIMIT_HMAC_SECRET: 'tsms_local_development_rate_limit_key_replace_in_production',
};

/** Parse and return the thrown message, failing the test if nothing was thrown. */
function rejection(parse, env) {
  try {
    parse(env);
  } catch (error) {
    return error.message;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('a complete production configuration', () => {
  it('is accepted, with the explicit bind host kept', () => {
    const parsed = parseApiEnvironment(production);
    expect(parsed.NODE_ENV).toBe('production');
    expect(parsed.API_HOST).toBe('10.20.30.40');
    expect(parsed.API_TRUSTED_ORIGINS).toEqual(['https://app.tsms.test']);
  });

  it('is accepted for the worker too', () => {
    expect(
      parseWorkerEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: production.DATABASE_URL,
        REDIS_URL: production.REDIS_URL,
      }).NODE_ENV,
    ).toBe('production');
  });

  it('accepts a private CA and client certificate alongside verify-full', () => {
    const url = `${production.DATABASE_URL}&sslrootcert=/etc/tsms/ca.pem&sslcert=/etc/tsms/client.pem&sslkey=/etc/tsms/client.key`;
    expect(parseApiEnvironment({ ...production, DATABASE_URL: url }).NODE_ENV).toBe('production');
  });
});

describe('development and test keep working with the local fixtures', () => {
  it.each(['development', 'test'])('accepts the committed fixtures in %s', (NODE_ENV) => {
    const parsed = parseApiEnvironment({ ...production, ...developmentFixtures, NODE_ENV });
    expect(parsed.API_HOST).toBe('127.0.0.1');
    expect(parsed.NODE_ENV).toBe(NODE_ENV);
  });

  it('accepts the committed fixtures for the worker outside production', () => {
    expect(
      parseWorkerEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: developmentFixtures.DATABASE_URL,
        REDIS_URL: developmentFixtures.REDIS_URL,
      }).NODE_ENV,
    ).toBe('test');
  });
});

describe('test mode cannot be confused with a real deployment', () => {
  const remote = {
    DATABASE_URL: 'postgresql://app:Zq8mV2xKp4Rt7NwBdG5h@db.internal.test:5432/tsms',
    REDIS_URL: 'redis://:Yw5nC9sLd3Fh6JpAeT1u@redis.internal.test:6379',
  };
  const local = {
    DATABASE_URL: 'postgresql://tsms:secret@127.0.0.1:5432/tsms_test',
    REDIS_URL: 'redis://:secret@127.0.0.1:6379/1',
  };
  const base = { ...production, ...developmentFixtures, NODE_ENV: 'test' };

  it('accepts loopback services', () => {
    expect(parseApiEnvironment({ ...base, ...local }).NODE_ENV).toBe('test');
    expect(parseWorkerEnvironment({ NODE_ENV: 'test', ...local }).NODE_ENV).toBe('test');
  });

  it.each(['DATABASE_URL', 'REDIS_URL'])('refuses a remote %s, naming only the key', (key) => {
    const message = rejection(parseApiEnvironment, { ...base, ...local, [key]: remote[key] });
    expect(message).toContain(key);
    expect(message).not.toContain('internal.test');
    expect(message).not.toContain('Zq8mV2xKp4Rt7NwBdG5h');
    expect(message).not.toContain('Yw5nC9sLd3Fh6JpAeT1u');
    const worker = rejection(parseWorkerEnvironment, {
      NODE_ENV: 'test',
      ...local,
      [key]: remote[key],
    });
    expect(worker).toContain(key);
  });

  it('leaves development free to use a shared remote service', () => {
    expect(parseApiEnvironment({ ...base, ...remote, NODE_ENV: 'development' }).NODE_ENV).toBe(
      'development',
    );
  });

  it('is not weakened by production rules being absent: production with a remote service is judged by its own rules', () => {
    // Production with the same remote URLs fails only because they lack TLS, not because they are remote.
    const message = rejection(parseApiEnvironment, {
      ...production,
      ...remote,
      NODE_ENV: 'production',
    });
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
  });
});

describe('NODE_ENV is explicit', () => {
  it('has no default for the API', () => {
    const env = { ...production };
    delete env.NODE_ENV;
    expect(() => parseApiEnvironment(env)).toThrow('Invalid environment configuration: NODE_ENV');
  });

  it('has no default for the worker', () => {
    expect(() =>
      parseWorkerEnvironment({
        DATABASE_URL: production.DATABASE_URL,
        REDIS_URL: production.REDIS_URL,
      }),
    ).toThrow('Invalid environment configuration: NODE_ENV');
  });

  it('rejects an unknown mode', () => {
    expect(() => parseApiEnvironment({ ...production, NODE_ENV: 'prod' })).toThrow('NODE_ENV');
    expect(() => parseApiEnvironment({ ...production, NODE_ENV: 'Production' })).toThrow(
      'NODE_ENV',
    );
  });
});

describe('production refuses each unsafe setting, by key name only', () => {
  const cases = [
    // [description, overrides, key that must be named, a value that must NOT appear in the message]
    ['an API bind host that was not stated', { API_HOST: undefined }, 'API_HOST', null],
    [
      'an http trusted origin',
      { API_TRUSTED_ORIGINS: 'http://app.tsms.test' },
      'API_TRUSTED_ORIGINS',
      'app.tsms.test',
    ],
    [
      'a loopback https trusted origin',
      { API_TRUSTED_ORIGINS: 'https://localhost' },
      'API_TRUSTED_ORIGINS',
      null,
    ],
    [
      'a 127.0.0.1 https trusted origin',
      { API_TRUSTED_ORIGINS: 'https://127.0.0.1:3000' },
      'API_TRUSTED_ORIGINS',
      null,
    ],
    [
      'one bad origin among good ones',
      { API_TRUSTED_ORIGINS: 'https://app.tsms.test,http://other.tsms.test' },
      'API_TRUSTED_ORIGINS',
      'other.tsms.test',
    ],
    [
      'the example HMAC secret from .env.example',
      { API_RATE_LIMIT_HMAC_SECRET: 'tsms_local_development_rate_limit_key_replace_in_production' },
      'API_RATE_LIMIT_HMAC_SECRET',
      'tsms_local_development',
    ],
    [
      'a secret that merely contains an example marker',
      { API_RATE_LIMIT_HMAC_SECRET: 'K7xQm2pR9vTb4nL6wYexampleD3fH5jS1gN0eU7iO2pA4yV6' },
      'API_RATE_LIMIT_HMAC_SECRET',
      'K7xQm2pR9vTb4nL6wYexample',
    ],
    [
      'the development PostgreSQL password',
      {
        DATABASE_URL:
          'postgresql://tsms:tsms_local_development@db.internal.test:5432/tsms?sslmode=verify-full',
      },
      'DATABASE_URL',
      'tsms_local_development',
    ],
    [
      'an empty PostgreSQL password',
      { DATABASE_URL: 'postgresql://tsms_app@db.internal.test:5432/tsms?sslmode=verify-full' },
      'DATABASE_URL',
      null,
    ],
    [
      'a PostgreSQL URL with no sslmode',
      { DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms` },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ],
    ...['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify'].map((mode) => [
      `sslmode=${mode}`,
      {
        DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=${mode}`,
      },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ]),
    [
      'verify-full with uselibpqcompat, which weakens other modes',
      {
        DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=verify-full&uselibpqcompat=true`,
      },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ],
    [
      'a repeated sslmode',
      {
        DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=disable&sslmode=verify-full`,
      },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ],
    [
      'a differently cased ssl parameter the driver would ignore',
      {
        DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=verify-full&SSLMODE=disable`,
      },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ],
    [
      'a conflicting ssl flag',
      {
        DATABASE_URL: `postgresql://tsms_app:${GOOD_DB_PASSWORD}@db.internal.test:5432/tsms?sslmode=verify-full&ssl=false`,
      },
      'DATABASE_URL',
      GOOD_DB_PASSWORD,
    ],
    [
      'a plaintext redis: URL',
      { REDIS_URL: `redis://:${GOOD_REDIS_PASSWORD}@redis.internal.test:6379` },
      'REDIS_URL',
      GOOD_REDIS_PASSWORD,
    ],
    [
      'a rediss: URL with a query string',
      { REDIS_URL: `rediss://:${GOOD_REDIS_PASSWORD}@redis.internal.test:6380?tls=false` },
      'REDIS_URL',
      GOOD_REDIS_PASSWORD,
    ],
    [
      'the development Redis password',
      { REDIS_URL: 'rediss://:tsms_local_redis@redis.internal.test:6380' },
      'REDIS_URL',
      'tsms_local_redis',
    ],
    [
      'an empty Redis password',
      { REDIS_URL: 'rediss://redis.internal.test:6380' },
      'REDIS_URL',
      null,
    ],
    [
      'process-wide certificate verification switched off',
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      'NODE_TLS_REJECT_UNAUTHORIZED',
      null,
    ],
  ];

  it.each(cases)('%s', (_description, overrides, key, forbidden) => {
    const message = rejection(parseApiEnvironment, { ...production, ...overrides });
    expect(message).toContain(key);
    expect(message.startsWith('Invalid environment configuration: ')).toBe(true);
    if (forbidden !== null) expect(message).not.toContain(forbidden);
    // Nothing else that was supplied may leak either.
    for (const secret of [GOOD_DB_PASSWORD, GOOD_REDIS_PASSWORD, GOOD_SECRET]) {
      expect(message).not.toContain(secret);
    }
  });

  it('applies the PostgreSQL, Redis, and TLS-verification rules to the worker as well', () => {
    const worker = {
      NODE_ENV: 'production',
      DATABASE_URL: production.DATABASE_URL,
      REDIS_URL: production.REDIS_URL,
    };
    expect(() =>
      parseWorkerEnvironment({
        ...worker,
        DATABASE_URL: production.DATABASE_URL.replace('verify-full', 'require'),
      }),
    ).toThrow('DATABASE_URL');
    expect(() =>
      parseWorkerEnvironment({ ...worker, REDIS_URL: 'redis://:x@redis.internal.test:6379' }),
    ).toThrow('REDIS_URL');
    expect(() => parseWorkerEnvironment({ ...worker, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('names every violated key and still reveals no value when several rules fail together', () => {
    const message = rejection(parseApiEnvironment, {
      ...production,
      ...developmentFixtures,
      NODE_ENV: 'production',
    });
    for (const key of [
      'API_HOST',
      'DATABASE_URL',
      'REDIS_URL',
      'API_TRUSTED_ORIGINS',
      'API_RATE_LIMIT_HMAC_SECRET',
    ]) {
      expect(message).toContain(key);
    }
    for (const leaked of [
      'tsms_local_development',
      'tsms_local_redis',
      '127.0.0.1',
      'replace_in_production',
    ]) {
      expect(message).not.toContain(leaked);
    }
  });
});
