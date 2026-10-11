import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '@tsms/config';

/**
 * Operational verification of the Stage 2.6 rate-limit key secret, as a test rather than an ad-hoc script.
 *
 * The hardening review asked specifically that this be verified: required wherever rate limiting is
 * enabled, shared consistently, never logged, never committed, and validated for sufficient length and
 * entropy. Length and the rejection cases are asserted against the parser directly here.
 *
 * The operational half - one shared value across replicas, injected rather than committed, never logged -
 * cannot be asserted by a unit test, because it is a property of how a deployment is configured. Those are
 * recorded as deployment requirements in `docs/security/RATE_LIMITING.md` and in `project-state.json`.
 */

const base = {
  NODE_ENV: 'test',
  API_PORT: '4000',
  WORKER_HOST: '127.0.0.1',
  WORKER_HEALTH_PORT: '4001',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/tsms',
  REDIS_URL: 'redis://:p@127.0.0.1:6379',
  API_TRUSTED_ORIGINS: 'https://app.example.com',
};

const verdict = (value) => {
  try {
    parseApiEnvironment({ ...base, API_RATE_LIMIT_HMAC_SECRET: value });
    return 'accepted';
  } catch {
    return 'rejected';
  }
};

describe('rate-limit key secret acceptance', () => {
  it('refuses to start the API without a secret, in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      // Copy and delete rather than destructure-and-omit, so no unused binding is introduced.
      const withoutSecret = { ...base, API_RATE_LIMIT_HMAC_SECRET: 'placeholder-for-this-case' };
      delete withoutSecret.API_RATE_LIMIT_HMAC_SECRET;
      expect(() => parseApiEnvironment({ ...withoutSecret, NODE_ENV })).toThrow(
        /API_RATE_LIMIT_HMAC_SECRET/,
      );
    }
  });

  it('accepts a value a secure generator would actually produce', () => {
    // Shaped like `crypto.randomBytes(32)` in base64url and in hex, since both are realistic.
    expect(verdict('K7xQm2pR9vTb4nL6wYcZ8aD3fH5jS1gN0eU7iO2pA4yV6')).toBe('accepted');
    expect(verdict('0123456789abcdef'.repeat(3))).toBe('accepted');
    expect(verdict('tsms_local_development_rate_limit_key_replace_in_production')).toBe('accepted');
  });

  it('refuses values a secure generator would never produce', () => {
    // Absent, empty, too short, too long, outside the character class, a placeholder, and a padded value
    // whose structure carries almost no entropy.
    expect(verdict('')).toBe('rejected');
    expect(verdict('a'.repeat(31))).toBe('rejected');
    expect(verdict('a'.repeat(513))).toBe('rejected');
    expect(verdict(`${'a'.repeat(32)}!`)).toBe('rejected');
    expect(verdict(`${'a'.repeat(32)} `)).toBe('rejected');
    expect(verdict('x'.repeat(32))).toBe('rejected');
    expect(verdict('abc'.repeat(11))).toBe('rejected');
    expect(verdict('abcd'.repeat(8))).toBe('rejected');
    expect(verdict('change-me-padding-0123456789abc')).toBe('rejected');
  });

  it('does not disclose a rejected value in the error it raises', () => {
    const weak = 'x'.repeat(32);
    let thrown;
    try {
      parseApiEnvironment({ ...base, API_RATE_LIMIT_HMAC_SECRET: weak });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toContain('API_RATE_LIMIT_HMAC_SECRET');
    expect(thrown.message).not.toContain(weak);
  });
});
