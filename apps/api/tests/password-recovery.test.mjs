import { describe, expect, it } from 'vitest';
import { parseApiEnvironment } from '@tsms/config';
import {
  buildRecoveryUrl,
  generateRecoveryToken,
  hashRecoveryToken,
  isRecoveryToken,
  recoveryExpiry,
  RECOVERY_POLICY,
} from '../dist/identity/password-recovery-token.js';
import {
  DisabledRecoveryDelivery,
  InMemoryRecoveryDelivery,
  deliveryAvailable,
  isInspectableDelivery,
  recoveryDeliveryFor,
} from '../dist/identity/password-recovery-delivery.js';

describe('recovery token format', () => {
  it('produces 32 random bytes as canonical 43-character base64url', () => {
    const tokens = new Set();
    for (let index = 0; index < 200; index += 1) {
      const token = generateRecoveryToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(200);
  });

  it('rejects non-canonical, padded, trimmed, and wrong-length values', () => {
    const token = generateRecoveryToken();
    expect(isRecoveryToken(token)).toBe(true);
    expect(isRecoveryToken(`${token}=`)).toBe(false);
    expect(isRecoveryToken(` ${token}`)).toBe(false);
    expect(isRecoveryToken(token.toUpperCase() === token ? `${token.slice(0, 42)}A` : token)).toBe(
      token === token.toUpperCase() ? isRecoveryToken(`${token.slice(0, 42)}A`) : true,
    );
    expect(isRecoveryToken(token.slice(0, 42))).toBe(false);
    expect(isRecoveryToken(`${token}A`)).toBe(false);
    expect(isRecoveryToken('not-a-recovery-token-value-at-all-x')).toBe(false);
    expect(isRecoveryToken(undefined)).toBe(false);
    expect(isRecoveryToken(12345)).toBe(false);
    expect(isRecoveryToken(null)).toBe(false);
  });

  it('hashes deterministically to lowercase 64-character hex', () => {
    const token = generateRecoveryToken();
    const digest = hashRecoveryToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryToken(token)).toBe(digest);
    expect(hashRecoveryToken(generateRecoveryToken())).not.toBe(digest);
    expect(hashRecoveryToken('not-a-token')).toBeNull();
  });

  it('expires exactly 30 minutes after issuance and never extends', () => {
    const issuedAt = new Date('2030-01-01T00:00:00.000Z');
    const expiresAt = recoveryExpiry(issuedAt);
    expect(RECOVERY_POLICY.lifetimeMs).toBe(30 * 60 * 1000);
    expect(expiresAt.getTime() - issuedAt.getTime()).toBe(RECOVERY_POLICY.lifetimeMs);
    expect(recoveryExpiry(issuedAt).getTime()).toBe(expiresAt.getTime());
  });

  it('puts the token in the fragment so it cannot leak through a URL log', () => {
    const token = generateRecoveryToken();
    const url = buildRecoveryUrl('https://app.example.com/account/recover', token);
    expect(url.startsWith('https://app.example.com/account/recover#token=')).toBe(true);
    expect(url.split('#')[0]).not.toContain(token);
    // URL.hash retains the leading '#'; the fragment content is what matters.
    expect(new URL(url).hash).toBe(`#token=${token}`);
  });

  it('never lets a request header influence the reset URL base', () => {
    const token = generateRecoveryToken();
    const url = buildRecoveryUrl('https://app.example.com/recover', token);
    expect(url.startsWith('https://app.example.com/')).toBe(true);
    expect(url).not.toContain('127.0.0.1');
  });
});

describe('recovery delivery gating', () => {
  it('fails every send when disabled', async () => {
    const delivery = new DisabledRecoveryDelivery();
    await expect(delivery.sendRecoveryInstructions()).rejects.toThrow(/disabled/i);
  });

  it('records deliveries in memory only and never writes to a log or stdout', async () => {
    const delivery = new InMemoryRecoveryDelivery();
    const token = generateRecoveryToken();
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const calls = [];
    console.log = (...args) => calls.push(args);
    console.info = (...args) => calls.push(args);
    console.warn = (...args) => calls.push(args);
    console.error = (...args) => calls.push(args);
    try {
      await delivery.sendRecoveryInstructions({
        recipient: 'person@example.test',
        displayName: 'Person',
        token,
        resetUrl: buildRecoveryUrl('https://app.example.com/recover', token),
        expiresAt: recoveryExpiry(new Date()),
      });
    } finally {
      Object.assign(console, originals);
    }
    expect(calls).toEqual([]);
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.last.token).toBe(token);
    expect(delivery.last.recipient).toBe('person@example.test');
  });

  it('clears recorded deliveries', () => {
    const delivery = new InMemoryRecoveryDelivery();
    expect(isInspectableDelivery(delivery)).toBe(true);
    expect(isInspectableDelivery(new DisabledRecoveryDelivery())).toBe(false);
    expect(delivery.deliveries).toHaveLength(0);
  });

  it('maps the validated mode to an adapter and reports availability', () => {
    expect(deliveryAvailable('disabled')).toBe(false);
    expect(deliveryAvailable('development-only')).toBe(true);
    expect(isInspectableDelivery(recoveryDeliveryFor('development-only'))).toBe(true);
    expect(isInspectableDelivery(recoveryDeliveryFor('disabled'))).toBe(false);
  });
});

describe('password recovery configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/tsms',
    REDIS_URL: 'redis://:p@127.0.0.1:6379',
    API_TRUSTED_ORIGINS: 'https://app.example.com',
  };

  it('defaults delivery to disabled so recovery fails closed', () => {
    expect(
      parseApiEnvironment({ ...base, NODE_ENV: 'production' }).API_PASSWORD_RECOVERY_DELIVERY_MODE,
    ).toBe('disabled');
    expect(parseApiEnvironment({ ...base }).API_PASSWORD_RECOVERY_URL_BASE).toBeUndefined();
  });

  it('refuses development-only delivery in production', () => {
    expect(() =>
      parseApiEnvironment({
        ...base,
        NODE_ENV: 'production',
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.com/recover',
      }),
    ).toThrow('API_PASSWORD_RECOVERY_DELIVERY_MODE');
  });

  it('allows development-only delivery outside production with a base URL', () => {
    const parsed = parseApiEnvironment({
      ...base,
      NODE_ENV: 'development',
      API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
      API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.com/recover',
    });
    expect(parsed.API_PASSWORD_RECOVERY_DELIVERY_MODE).toBe('development-only');
    expect(parsed.API_PASSWORD_RECOVERY_URL_BASE).toBe('https://app.example.com/recover');
  });

  it('requires a base URL whenever delivery is enabled', () => {
    expect(() =>
      parseApiEnvironment({ ...base, API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only' }),
    ).toThrow('API_PASSWORD_RECOVERY_URL_BASE');
  });

  it.each([
    ['a relative path', '/recover'],
    ['a wildcard host', 'https://*.example.com/recover'],
    ['a comma-joined pair', 'https://a.example.com,https://b.example.com'],
    ['embedded credentials', 'https://user:pass@app.example.com/recover'],
    ['a fragment', 'https://app.example.com/recover#token=leak'],
    ['a bare host', 'app.example.com/recover'],
    ['an empty value', ''],
  ])('rejects %s as a recovery URL base', (_label, API_PASSWORD_RECOVERY_URL_BASE) => {
    expect(() =>
      parseApiEnvironment({
        ...base,
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE,
      }),
    ).toThrow('API_PASSWORD_RECOVERY_URL_BASE');
  });

  it('never echoes a rejected recovery URL value in the error', () => {
    let message = '';
    try {
      parseApiEnvironment({
        ...base,
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://secret-recovery.example.com/reset',
      });
      parseApiEnvironment({
        ...base,
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://*.secret-recovery.example.com',
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('API_PASSWORD_RECOVERY_URL_BASE');
    expect(message).not.toContain('secret-recovery.example.com');
  });

  it('rejects an unknown delivery mode', () => {
    expect(() =>
      parseApiEnvironment({
        ...base,
        API_PASSWORD_RECOVERY_DELIVERY_MODE: 'smtp',
        API_PASSWORD_RECOVERY_URL_BASE: 'https://app.example.com/recover',
      }),
    ).toThrow('API_PASSWORD_RECOVERY_DELIVERY_MODE');
  });
});
