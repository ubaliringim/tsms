import { describe, expect, it } from 'vitest';
import {
  parseApiEnvironment,
  parseIntegrationEnvironment,
  parseWorkerEnvironment,
} from '../dist/env.js';

const valid = {
  DATABASE_URL: 'postgresql://tsms:secret@127.0.0.1:5432/tsms',
  REDIS_URL: 'redis://:secret@127.0.0.1:6379',
};

// Stage 2.4 requires an explicit browser-origin allowlist. Its validation is covered by the
// dedicated block below; the general shape assertions here only need a usable value.
const trustedOrigins = { API_TRUSTED_ORIGINS: 'https://app.example.com,http://127.0.0.1:3000' };
const apiValid = { ...valid, ...trustedOrigins };

describe('server environment boundary', () => {
  it('requires declared infrastructure endpoints and applies safe host defaults', () => {
    expect(parseApiEnvironment({ ...apiValid })).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      ...valid,
      API_TRUSTED_ORIGINS: ['https://app.example.com', 'http://127.0.0.1:3000'],
    });
    expect(parseWorkerEnvironment({ ...valid }).WORKER_HEALTH_PORT).toBe(4001);
  });

  it('requires a browser-origin allowlist for the API and never for the worker', () => {
    expect(() => parseApiEnvironment({ ...valid })).toThrow(
      'Invalid environment configuration: API_TRUSTED_ORIGINS',
    );
    expect(() => parseApiEnvironment({ ...valid, API_TRUSTED_ORIGINS: '' })).toThrow(
      'API_TRUSTED_ORIGINS',
    );
    // The worker serves no browser surface, so it does not carry the allowlist.
    expect(parseWorkerEnvironment({ ...valid }).API_TRUSTED_ORIGINS).toBeUndefined();
  });

  it('fails when a required infrastructure endpoint is missing', () => {
    expect(() => parseApiEnvironment({ REDIS_URL: valid.REDIS_URL, ...trustedOrigins })).toThrow(
      'Invalid environment configuration: DATABASE_URL',
    );
    expect(() =>
      parseApiEnvironment({ DATABASE_URL: valid.DATABASE_URL, ...trustedOrigins }),
    ).toThrow('Invalid environment configuration: REDIS_URL');
    expect(() => parseWorkerEnvironment({ REDIS_URL: valid.REDIS_URL })).toThrow(
      'Invalid environment configuration: DATABASE_URL',
    );
    expect(() => parseWorkerEnvironment({ DATABASE_URL: valid.DATABASE_URL })).toThrow(
      'Invalid environment configuration: REDIS_URL',
    );
  });

  it.each([
    ['DATABASE_URL', 'not-a-url'],
    ['DATABASE_URL', 'mysql://tsms:secret@127.0.0.1:3306/tsms'],
    ['DATABASE_URL', 'postgresql://tsms:secret@127.0.0.1:5432'],
    ['DATABASE_URL', ''],
    ['REDIS_URL', 'not-a-url'],
    ['REDIS_URL', 'http://127.0.0.1:6379'],
    ['REDIS_URL', ''],
  ])('rejects a malformed %s without echoing the supplied value', (key, value) => {
    expect(() => parseApiEnvironment({ ...apiValid, [key]: value })).toThrow(key);
    try {
      parseApiEnvironment({ ...apiValid, [key]: value });
      expect.unreachable('expected validation to fail');
    } catch (error) {
      // The message names keys only. It can never contain the password, and for a
      // non-empty value it must not contain that value either.
      expect(error.message).not.toContain('secret');
      if (value !== '') {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it('parses explicitly configured ports and strips unrelated values', () => {
    expect(
      parseApiEnvironment({
        API_PORT: '4100',
        NODE_ENV: 'test',
        DATABASE_URL: valid.DATABASE_URL,
        REDIS_URL: valid.REDIS_URL,
        API_TRUSTED_ORIGINS: trustedOrigins.API_TRUSTED_ORIGINS,
        UNRELATED_SECRET: 'private',
      }),
    ).toEqual({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4100,
      ...valid,
      API_TRUSTED_ORIGINS: ['https://app.example.com', 'http://127.0.0.1:3000'],
    });
  });

  it.each(['', '0', '-1', '65536', '12.5', '1e3', 'not-a-port'])(
    'rejects malformed or out-of-range port %j before startup',
    (value) => {
      expect(() => parseApiEnvironment({ ...apiValid, API_PORT: value })).toThrow('API_PORT');
      expect(() => parseWorkerEnvironment({ ...valid, WORKER_HEALTH_PORT: value })).toThrow(
        'WORKER_HEALTH_PORT',
      );
    },
  );

  it('rejects invalid mode and empty bind host without exposing supplied values', () => {
    expect(() =>
      parseApiEnvironment({ ...apiValid, NODE_ENV: 'sensitive-input', API_HOST: '' }),
    ).toThrow('Invalid environment configuration: NODE_ENV, API_HOST');
    try {
      parseApiEnvironment({ ...apiValid, API_PORT: 'private-value' });
    } catch (error) {
      expect(error.message).not.toContain('private-value');
    }
  });
});

describe('integration test environment boundary', () => {
  const testEnv = {
    NODE_ENV: 'test',
    TEST_DATABASE_URL: 'postgresql://tsms:secret@127.0.0.1:5432/tsms_test',
    TEST_REDIS_URL: 'redis://:secret@127.0.0.1:6379/1',
  };

  it('accepts an isolated test configuration', () => {
    expect(parseIntegrationEnvironment({ ...testEnv })).toEqual(testEnv);
  });

  it('does not fall back to the application DATABASE_URL or REDIS_URL', () => {
    expect(() =>
      parseIntegrationEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: valid.DATABASE_URL,
        REDIS_URL: valid.REDIS_URL,
      }),
    ).toThrow('Invalid environment configuration: TEST_DATABASE_URL, TEST_REDIS_URL');
  });

  it('refuses to run outside NODE_ENV=test', () => {
    expect(() => parseIntegrationEnvironment({ ...testEnv, NODE_ENV: 'production' })).toThrow(
      'Invalid environment configuration: NODE_ENV',
    );
    expect(() => parseIntegrationEnvironment({ ...testEnv, NODE_ENV: undefined })).toThrow(
      'Invalid environment configuration: NODE_ENV',
    );
  });
});
