import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { validatePassword } from '../dist/identity/password-policy.js';
import {
  hashPassword,
  verifyPassword,
  needsPasswordRehash,
} from '../dist/identity/password-hasher.js';
import { PasswordCredentialService } from '../dist/identity/password-credential.service.js';

// Runtime synthetic candidates only; assertions operate on booleans to avoid secret diffs.
const candidate = `  ${randomBytes(24).toString('hex')}  `;
let encoded;
beforeAll(async () => {
  encoded = await hashPassword(candidate);
});

describe('password policy', () => {
  it('rejects below minimum and accepts minimum', () => {
    expect(validatePassword('a'.repeat(14)).valid).toBe(false);
    expect(validatePassword('a'.repeat(15)).valid).toBe(true);
  });
  it('accepts maximum and rejects above maximum', () => {
    expect(validatePassword('a'.repeat(128)).valid).toBe(true);
    expect(validatePassword('a'.repeat(129)).valid).toBe(false);
    expect(validatePassword('a'.repeat(10000)).valid).toBe(false);
  });
  it('allows passphrases, spaces and no composition rules', () => {
    for (const value of ['word '.repeat(5), ' '.repeat(15), 'a'.repeat(15), '1'.repeat(15)])
      expect(validatePassword(value).valid).toBe(true);
  });
  it('counts Unicode scalars, rejecting lone surrogates', () => {
    expect(validatePassword('\u{1F680}'.repeat(15)).valid).toBe(true);
    expect(validatePassword('\u{1F680}'.repeat(14)).valid).toBe(false);
    expect(validatePassword('\u{1F680}'.repeat(128)).valid).toBe(true);
    expect(validatePassword('a'.repeat(15) + '\uD800').valid).toBe(false);
  });
  it('rejects empty and invalid types without coercion', () => {
    for (const value of ['', null, undefined, 123, {}, [], Buffer.alloc(20)])
      expect(validatePassword(value).valid).toBe(false);
  });
});

describe('production Argon2id', () => {
  it('encodes explicit production costs and 32-byte output, never plaintext', () => {
    expect(encoded.startsWith('$argon2id$v=19$m=65536,p=1,t=3$')).toBe(true);
    expect(Buffer.from(encoded.split('$')[5], 'base64').length).toBe(32);
    expect(encoded === candidate).toBe(false);
    expect(encoded.includes(candidate)).toBe(false);
  });
  it('uses unique salts and both results verify', async () => {
    const second = await hashPassword(candidate);
    expect(encoded === second).toBe(false);
    expect(encoded.split('$')[4] === second.split('$')[4]).toBe(false);
    expect((await verifyPassword(candidate, encoded)).matches).toBe(true);
    expect((await verifyPassword(candidate, second)).matches).toBe(true);
  });
  it('rejects wrong passwords without a rehash hint', async () => {
    expect(await verifyPassword(candidate + 'x', encoded)).toEqual({
      matches: false,
      needsRehash: false,
    });
  });
  it('preserves leading/trailing whitespace and case', async () => {
    expect((await verifyPassword(candidate.trim(), encoded)).matches).toBe(false);
    const mixed = `A${candidate}`;
    const hash = await hashPassword(mixed);
    expect((await verifyPassword(mixed.toLowerCase(), hash)).matches).toBe(false);
  });
  it('does not normalize Unicode', async () => {
    const value = '\u00e9'.repeat(15);
    const hash = await hashPassword(value);
    expect((await verifyPassword(value, hash)).matches).toBe(true);
    expect((await verifyPassword(value.normalize('NFD'), hash)).matches).toBe(false);
  });
  it('rejects invalid candidates before hashing or verification', async () => {
    await expect(hashPassword(null)).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    expect((await verifyPassword('', encoded)).matches).toBe(false);
    expect((await verifyPassword({}, encoded)).matches).toBe(false);
  });
  it('treats corrupt, other-algorithm and oversized-cost hashes as operational errors', async () => {
    for (const value of [
      'corrupt',
      '',
      encoded.replace('argon2id', 'argon2i'),
      encoded.replace('m=65536', 'm=999999'),
      encoded.slice(0, -1) + '!',
    ]) {
      await expect(verifyPassword(candidate, value)).rejects.toMatchObject({
        code: 'VERIFICATION_FAILURE',
      });
      expect(() => needsPasswordRehash(value)).toThrow('VERIFICATION_FAILURE');
    }
  });
  it('detects an older test-only hash and upgrades with production parameters', async () => {
    // Deliberately weak historical fixture only. No configurable production cost injection.
    const old = await argon2.hash(candidate, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    expect(await verifyPassword(candidate, old)).toEqual({ matches: true, needsRehash: true });
    expect(needsPasswordRehash(old)).toBe(true);
    expect(needsPasswordRehash(encoded)).toBe(false);
    const upgraded = await hashPassword(candidate);
    expect(await verifyPassword(candidate, upgraded)).toEqual({
      matches: true,
      needsRehash: false,
    });
  });
  it('detects output length evolution as well as library-supported costs', async () => {
    const old = await argon2.hash(candidate, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 16,
    });
    expect(needsPasswordRehash(old)).toBe(true);
  });
  it('sanitizes database failures without attaching credential material', async () => {
    const service = new PasswordCredentialService({
      passwordCredential: {
        findUnique: async () => {
          throw new Error(candidate + encoded);
        },
      },
    });
    try {
      await service.verifyCredential('unused', candidate);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error.code).toBe('PERSISTENCE_FAILURE');
      expect(error.message.includes(candidate) || error.message.includes(encoded)).toBe(false);
      expect(error.cause).toBeUndefined();
    }
  });
});
