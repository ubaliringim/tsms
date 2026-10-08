import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  isSessionToken,
  SESSION_POLICY,
} from '../dist/identity/session-token.js';
import { SessionService } from '../dist/identity/session.service.js';

describe('session token security', () => {
  it('generates canonical URL-safe 32-byte CSPRNG tokens, distinct from identifiers', () => {
    const tokens = Array.from({ length: 32 }, () => generateSessionToken());
    expect(new Set(tokens).size).toBe(32);
    for (const token of tokens) {
      expect(isSessionToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url').length).toBe(32);
      expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    }
    expect(isSessionToken(randomUUID())).toBe(false);
  });
  it('hashes the exact token with SHA-256, deterministically as lowercase hex', () => {
    const token = generateSessionToken(),
      other = generateSessionToken();
    const digest = hashSessionToken(token);
    expect(digest === hashSessionToken(token)).toBe(true);
    expect(digest === createHash('sha256').update(token, 'utf8').digest('hex')).toBe(true);
    expect(/^[a-f0-9]{64}$/.test(digest)).toBe(true);
    expect(digest === hashSessionToken(other)).toBe(false);
    expect(digest.includes(token)).toBe(false);
  });
  it('rejects invalid types, noncanonical padding bits, encoding and whitespace', () => {
    const token = generateSessionToken();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)) + 1];
    expect(Buffer.from(alias, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(true);
    for (const value of [
      null,
      undefined,
      {},
      12,
      '',
      token + '=',
      ' ' + token,
      token + '\n',
      alias,
      '+'.repeat(43),
      'x'.repeat(10000),
    ]) {
      expect(isSessionToken(value)).toBe(false);
      expect(() => hashSessionToken(value)).toThrow('INVALID_TOKEN');
    }
  });
  it('has immutable production entropy and lifetime settings', () => {
    expect(Object.isFrozen(SESSION_POLICY)).toBe(true);
    expect(() => {
      SESSION_POLICY.tokenBytes = 1;
    }).toThrow(TypeError);
    expect(SESSION_POLICY.lifetimeMs).toBe(604800000);
  });
});

describe('session failure boundaries', () => {
  it('rejects malformed tokens and IDs before database access', async () => {
    const database = {
      session: { findUnique: vi.fn(), updateMany: vi.fn() },
      user: { findUnique: vi.fn() },
    };
    const service = new SessionService(database);
    await expect(service.validateSession('invalid')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    await expect(service.createSession({})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.createSession(randomUUID() + '\n')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.revokeSession(randomUUID(), '')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.revokeAllUserSessions(null)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(database.user.findUnique).not.toHaveBeenCalled();
    expect(database.session.findUnique).not.toHaveBeenCalled();
    expect(database.session.updateMany).not.toHaveBeenCalled();
  });
  for (const operation of [
    'createSession',
    'validateSession',
    'revokeSession',
    'revokeAllUserSessions',
  ]) {
    it(`${operation} fails closed with sanitized database errors`, async () => {
      const token = generateSessionToken(),
        digest = hashSessionToken(token);
      const failure = async () => {
        throw new Error(token + digest);
      };
      const service = new SessionService({
        user: { findUnique: failure },
        session: { findUnique: failure, updateMany: failure },
      });
      const args = operation === 'validateSession' ? [token] : [randomUUID(), randomUUID()];
      try {
        await service[operation](...args);
        throw new Error('Expected failure');
      } catch (error) {
        expect(error.code).toBe('SERVICE_FAILURE');
        expect(error.message.includes(token) || error.message.includes(digest)).toBe(false);
        expect(error.cause).toBeUndefined();
      }
    });
  }
  it('rejects identifiers that are not an exact canonical UUID', async () => {
    const database = {
      user: { findUnique: vi.fn() },
      session: { findUnique: vi.fn(), updateMany: vi.fn() },
    };
    const service = new SessionService(database);
    const id = randomUUID();
    // Line terminators matter because JavaScript `$` can match before a trailing
    // terminator. The service pairs a fully anchored regex with an exact 36
    // character length check; this test pins the rejected shapes rather than
    // assuming which of the two does the rejecting.
    for (const rejected of [
      id + '\n',
      id + '\r',
      id + '\u2028',
      id + '\u2029',
      id + ' ',
      id.slice(0, 35),
      id + 'X',
      `{${id}}`,
      `urn:uuid:${id}`,
      `${id.slice(0, -1)}+`,
      'z'.repeat(36),
    ]) {
      await expect(service.createSession(rejected)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(service.revokeAllUserSessions(rejected)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    // A genuine UUID is accepted by validation and proceeds to the database.
    await expect(service.createSession(id.toUpperCase())).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
    expect(database.user.findUnique).toHaveBeenCalledTimes(1);
  });
  it('fails closed on an invalid clock without attempting persistence', async () => {
    const create = vi.fn();
    const service = new SessionService(
      { user: { findUnique: async () => ({ status: 'ACTIVE' }) }, session: { create } },
      () => new Date(NaN),
    );
    await expect(service.createSession(randomUUID())).rejects.toMatchObject({
      code: 'SERVICE_FAILURE',
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('samples expiry after database lookup rather than before it', async () => {
    let time = 0;
    const service = new SessionService(
      {
        session: {
          findUnique: async () => {
            time = 100;
            return {
              id: randomUUID(),
              userId: randomUUID(),
              expiresAt: new Date(100),
              revokedAt: null,
              user: { status: 'ACTIVE' },
            };
          },
        },
      },
      () => new Date(time),
    );
    await expect(service.validateSession(generateSessionToken())).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
});
