import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { PasswordCredentialService } from '../dist/identity/password-credential.service.js';
import { verifyPassword } from '../dist/identity/password-hasher.js';

let db, service;
const ids = [];
const candidate = () => randomBytes(24).toString('base64url');
beforeAll(() => {
  const env = parseIntegrationEnvironment(process.env);
  db = createDatabaseClient(assertDisposableTestDatabase(env.TEST_DATABASE_URL));
  service = new PasswordCredentialService(db);
});
afterEach(async () => {
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
});
afterAll(async () => {
  if (db) await closeDatabase(db);
});
async function user() {
  const email = `${randomUUID()}@example.test`;
  const result = await db.user.create({
    data: { email, normalizedEmail: email, displayName: 'Synthetic' },
  });
  ids.push(result.id);
  return result.id;
}

describe('internal password credential persistence', () => {
  it('creates hash-only credentials with lifecycle timestamps and safe return fields', async () => {
    const id = await user(),
      value = candidate(),
      before = Date.now();
    const result = await service.createPasswordCredential(id, value);
    expect(Object.keys(result).sort()).toEqual(['id', 'passwordChangedAt', 'userId']);
    const row = await db.passwordCredential.findUniqueOrThrow({ where: { userId: id } });
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row.passwordHash === value).toBe(false);
    expect(row.passwordChangedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await service.verifyCredential(id, value)).matches).toBe(true);
    expect(JSON.stringify(result).includes(value)).toBe(false);
  });
  it('rejects duplicate creation including races without overwriting the winner', async () => {
    const id = await user(),
      a = candidate(),
      b = candidate();
    const results = await Promise.allSettled([
      service.createPasswordCredential(id, a),
      service.createPasswordCredential(id, b),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(results.find((x) => x.status === 'rejected').reason.code).toBe('CREDENTIAL_EXISTS');
    expect(await db.passwordCredential.count({ where: { userId: id } })).toBe(1);
    const winner = results[0].status === 'fulfilled' ? a : b;
    expect((await service.verifyCredential(id, winner)).matches).toBe(true);
  });
  it('rejects nonexistent users through the existing FK', async () => {
    await expect(service.createPasswordCredential(randomUUID(), candidate())).rejects.toMatchObject(
      { code: 'USER_NOT_FOUND' },
    );
  });
  it('rejects invalid passwords without writing credentials', async () => {
    const id = await user();
    await expect(service.createPasswordCredential(id, '')).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    expect(await db.passwordCredential.count({ where: { userId: id } })).toBe(0);
  });
  it('replaces a credential, advances time, verifies new and rejects old password', async () => {
    const id = await user(),
      old = candidate(),
      next = candidate();
    const created = await service.createPasswordCredential(id, old);
    const prior = await db.passwordCredential.findUniqueOrThrow({ where: { userId: id } });
    const replaced = await service.changePassword(id, next);
    const row = await db.passwordCredential.findUniqueOrThrow({ where: { userId: id } });
    expect(row.passwordHash === prior.passwordHash).toBe(false);
    expect(replaced.passwordChangedAt.getTime()).toBeGreaterThan(
      created.passwordChangedAt.getTime(),
    );
    expect((await verifyPassword(next, row.passwordHash)).matches).toBe(true);
    expect((await service.verifyCredential(id, old)).matches).toBe(false);
    expect(Object.keys(replaced).sort()).toEqual(['id', 'passwordChangedAt', 'userId']);
  });
  it('requires a credential for replacement and verification', async () => {
    const id = await user();
    await expect(service.changePassword(id, candidate())).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });
    await expect(service.verifyCredential(id, candidate())).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });
  });
  it('leaves the old credential intact when replacement violates policy', async () => {
    const id = await user(),
      value = candidate();
    const original = await service.createPasswordCredential(id, value);
    await expect(service.changePassword(id, null)).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    expect((await service.verifyCredential(id, value)).matches).toBe(true);
    const row = await db.passwordCredential.findUniqueOrThrow({ where: { userId: id } });
    expect(row.passwordChangedAt.getTime()).toBe(original.passwordChangedAt.getTime());
  });
  it('rejects a concurrent replacement instead of silently overwriting it', async () => {
    const id = await user();
    await service.createPasswordCredential(id, candidate());
    let reads = 0,
      release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const racing = new PasswordCredentialService({
      passwordCredential: {
        findUnique: async (args) => {
          const row = await db.passwordCredential.findUnique(args);
          if (++reads === 2) release();
          await barrier;
          return row;
        },
        updateMany: (args) => db.passwordCredential.updateMany(args),
      },
    });
    const values = [candidate(), candidate()];
    const outcomes = await Promise.allSettled(
      values.map((value) => racing.changePassword(id, value)),
    );
    expect(outcomes.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(outcomes.find((x) => x.status === 'rejected').reason.code).toBe('CONCURRENT_CHANGE');
    const winner = outcomes.findIndex((x) => x.status === 'fulfilled');
    expect((await service.verifyCredential(id, values[winner])).matches).toBe(true);
    expect((await service.verifyCredential(id, values[1 - winner])).matches).toBe(false);
  });
});
