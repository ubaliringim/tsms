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

describe('server environment boundary', () => {
  it('requires declared infrastructure endpoints and applies safe host defaults', () => {
    expect(parseApiEnvironment({ ...valid })).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      ...valid,
    });
    expect(parseWorkerEnvironment({ ...valid }).WORKER_HEALTH_PORT).toBe(4001);
  });

  it('fails when a required infrastructure endpoint is missing', () => {
    expect(() => parseApiEnvironment({ REDIS_URL: valid.REDIS_URL })).toThrow(
      'Invalid environment configuration: DATABASE_URL',
    );
    expect(() => parseApiEnvironment({ DATABASE_URL: valid.DATABASE_URL })).toThrow(
      'Invalid environment configuration: REDIS_URL',
    );
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
    expect(() => parseApiEnvironment({ ...valid, [key]: value })).toThrow(key);
    try {
      parseApiEnvironment({ ...valid, [key]: value });
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
        UNRELATED_SECRET: 'private',
      }),
    ).toEqual({ NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: 4100, ...valid });
  });

  it.each(['', '0', '-1', '65536', '12.5', '1e3', 'not-a-port'])(
    'rejects malformed or out-of-range port %j before startup',
    (value) => {
      expect(() => parseApiEnvironment({ ...valid, API_PORT: value })).toThrow('API_PORT');
      expect(() => parseWorkerEnvironment({ ...valid, WORKER_HEALTH_PORT: value })).toThrow(
        'WORKER_HEALTH_PORT',
      );
    },
  );

  it('rejects invalid mode and empty bind host without exposing supplied values', () => {
    expect(() =>
      parseApiEnvironment({ ...valid, NODE_ENV: 'sensitive-input', API_HOST: '' }),
    ).toThrow('Invalid environment configuration: NODE_ENV, API_HOST');
    try {
      parseApiEnvironment({ ...valid, API_PORT: 'private-value' });
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
