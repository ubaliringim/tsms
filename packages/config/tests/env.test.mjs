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
// Stage 2.6 requires the rate-limit key secret in every environment. These cases assert other
// keys, so a valid one has to be present or they would all fail on this first and prove nothing.
const rateLimitSecret = {
  API_RATE_LIMIT_HMAC_SECRET: 'stage26_config_test_only_rate_limit_key_0123456789',
};
const apiValid = { ...valid, ...trustedOrigins, ...rateLimitSecret };

describe('server environment boundary', () => {
  it('requires declared infrastructure endpoints and applies safe host defaults', () => {
    expect(parseApiEnvironment({ ...apiValid })).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      ...valid,
      API_TRUSTED_ORIGINS: ['https://app.example.com', 'http://127.0.0.1:3000'],
      API_RATE_LIMIT_HMAC_SECRET: rateLimitSecret.API_RATE_LIMIT_HMAC_SECRET,
      // Stage 2.5: delivery is disabled by default, so recovery fails closed.
      API_PASSWORD_RECOVERY_DELIVERY_MODE: 'disabled',
    });
    expect(parseWorkerEnvironment({ ...valid }).WORKER_HEALTH_PORT).toBe(4001);
  });

  it('defaults password recovery to disabled with no URL base', () => {
    const parsed = parseApiEnvironment({ ...apiValid, NODE_ENV: 'production' });
    expect(parsed.API_PASSWORD_RECOVERY_DELIVERY_MODE).toBe('disabled');
    expect(parsed.API_PASSWORD_RECOVERY_URL_BASE).toBeUndefined();
  });

  it('refuses development-only recovery delivery in production', () => {
    expect(() =>
      parseApiEnvironment({
        ...apiValid,
        NODE_ENV: 'production',
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.com/recover',
      }),
    ).toThrow('API_PASSWORD_RECOVERY_DELIVERY_MODE');
  });

  it('requires a recovery URL base when delivery is enabled', () => {
    expect(() =>
      parseApiEnvironment({ ...apiValid, API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only' }),
    ).toThrow('API_PASSWORD_RECOVERY_URL_BASE');
    expect(
      parseApiEnvironment({
        ...apiValid,
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.com/recover',
      }).API_PASSWORD_RECOVERY_URL_BASE,
    ).toBe('https://app.example.com/recover');
  });

  it('rejects a recovery URL base that could redirect a victim elsewhere', () => {
    for (const API_PASSWORD_RECOVERY_URL_BASE of [
      '/recover',
      'https://*.example.com/recover',
      'https://user:pass@app.example.com/recover',
      'https://app.example.com/recover?next=https://evil.test',
      'app.example.com/recover',
    ]) {
      expect(() =>
        parseApiEnvironment({
          ...apiValid,
          API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
          API_PASSWORD_RECOVERY_URL_BASE,
        }),
      ).toThrow('API_PASSWORD_RECOVERY_URL_BASE');
    }
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
        API_RATE_LIMIT_HMAC_SECRET: rateLimitSecret.API_RATE_LIMIT_HMAC_SECRET,
        UNRELATED_SECRET: 'private',
      }),
    ).toEqual({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4100,
      ...valid,
      API_TRUSTED_ORIGINS: ['https://app.example.com', 'http://127.0.0.1:3000'],
      API_RATE_LIMIT_HMAC_SECRET: rateLimitSecret.API_RATE_LIMIT_HMAC_SECRET,
      API_PASSWORD_RECOVERY_DELIVERY_MODE: 'disabled',
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

  // Stage 2.6 hardening. The rate-limit key secret is the only thing standing between an operator with
  // Redis access and the ability to correlate or precompute rate-limit keys, so its validation is asserted
  // directly rather than assumed.
  it('requires the rate-limit key secret in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      // Copy and delete rather than destructure-and-omit, so no unused binding is introduced.
      const withoutSecret = { ...apiValid };
      delete withoutSecret.API_RATE_LIMIT_HMAC_SECRET;
      expect(() => parseApiEnvironment({ ...withoutSecret, NODE_ENV })).toThrow(
        /API_RATE_LIMIT_HMAC_SECRET/,
      );
    }
  });

  it('accepts a long random-looking secret and returns it unchanged', () => {
    const secret = 'K7xQm2pR9vTb4nL6wYcZ8aD3fH5jS1gN0eU7iO2pA4yV6';
    expect(parseApiEnvironment(apiValid).API_RATE_LIMIT_HMAC_SECRET).toBe(
      rateLimitSecret.API_RATE_LIMIT_HMAC_SECRET,
    );
    expect(
      parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: secret })
        .API_RATE_LIMIT_HMAC_SECRET,
    ).toBe(secret);
  });

  it('rejects a secret that is shorter, longer, or outside the character class', () => {
    expect(() =>
      parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: 'a'.repeat(31) }),
    ).toThrow(/API_RATE_LIMIT_HMAC_SECRET/);
    expect(() =>
      parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: 'a'.repeat(513) }),
    ).toThrow(/API_RATE_LIMIT_HMAC_SECRET/);
    for (const invalid of [`${'a'.repeat(32)}!`, `${'a'.repeat(32)} `, `${'a'.repeat(32)}+`]) {
      expect(() =>
        parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: invalid }),
      ).toThrow(/API_RATE_LIMIT_HMAC_SECRET/);
    }
  });

  it('rejects a padded value whose structure carries almost no entropy', () => {
    // A length rule alone would accept every one of these. They are the shapes a value takes when it is
    // padded to satisfy a minimum-length check.
    // Each of these is a length-legal value whose structure carries almost no entropy. The repeated-hex
    // case is deliberately absent from the *code* rule and is covered by the note below: rejecting every
    // low-entropy-looking string would reject real base64 secrets, which are frequently hex-shaped.
    for (const weak of [
      'x'.repeat(32),
      'a'.repeat(64),
      'abcabcabcabcabcabcabcabcabcabc',
      'ababababababababababababababababab',
      'abcd'.repeat(8),
    ]) {
      expect(() => parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: weak })).toThrow(
        /API_RATE_LIMIT_HMAC_SECRET/,
      );
    }
  });

  it('rejects a known placeholder regardless of length', () => {
    for (const placeholder of ['change-me', 'CHANGEME', 'placeholder', 'secret', 'test']) {
      expect(() =>
        parseApiEnvironment({
          ...apiValid,
          API_RATE_LIMIT_HMAC_SECRET: `${placeholder}-padding-0123456789`,
        }),
      ).toThrow(/API_RATE_LIMIT_HMAC_SECRET/);
    }
  });

  it('never echoes a rejected secret in the error message', () => {
    const weak = 'x'.repeat(32);
    let thrown;
    try {
      parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: weak });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // The message names the key so an operator can find it, and never the value or any fragment of it.
    expect(thrown.message).toContain('API_RATE_LIMIT_HMAC_SECRET');
    expect(thrown.message).not.toContain(weak);
    expect(thrown.message).not.toContain('xxxxxxxx');
  });

  it('accepts a long hex-shaped value, because real random secrets look like that', () => {
    // The guard must not reject a legitimate secret for looking low-entropy. `crypto.randomBytes(32)`
    // rendered as hex is exactly this shape, and rejecting it would push operators toward weaker values.
    const hex = '0123456789abcdef'.repeat(3);
    expect(
      parseApiEnvironment({ ...apiValid, API_RATE_LIMIT_HMAC_SECRET: hex })
        .API_RATE_LIMIT_HMAC_SECRET,
    ).toBe(hex);
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
