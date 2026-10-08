import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { SessionService } from '../dist/identity/session.service.js';
import { generateSessionToken, hashSessionToken } from '../dist/identity/session-token.js';

let db, service, time;
const ids = [];
const epoch = Date.parse('2030-01-01T00:00:00.000Z');
const lifetime = 604800000;
beforeAll(() => {
  const env = parseIntegrationEnvironment(process.env);
  db = createDatabaseClient(assertDisposableTestDatabase(env.TEST_DATABASE_URL));
});
beforeEach(() => {
  time = epoch;
  service = new SessionService(db, () => new Date(time));
});
afterEach(async () => {
  if (!db) return;
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
});
afterAll(async () => {
  if (db) await closeDatabase(db);
});
async function user(status = 'ACTIVE') {
  const email = `${randomUUID()}@example.test`;
  const row = await db.user.create({
    data: { email, normalizedEmail: email, displayName: 'Synthetic Session Identity', status },
  });
  ids.push(row.id);
  return row.id;
}
const rowFor = (id) => db.session.findUniqueOrThrow({ where: { id } });

describe('server-managed session persistence', () => {
  it('creates a fixed-lifetime session storing only the digest, returning the secret once', async () => {
    const id = await user(),
      result = await service.createSession(id),
      row = await rowFor(result.sessionId);
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'sessionId', 'token']);
    expect(row.tokenHash === hashSessionToken(result.token)).toBe(true);
    expect(JSON.stringify(row).includes(result.token)).toBe(false);
    expect(result.token === row.id || result.token.includes(id)).toBe(false);
    expect(row.createdAt.getTime()).toBe(epoch);
    expect(row.expiresAt.getTime()).toBe(epoch + lifetime);
    expect(result.expiresAt.getTime()).toBe(row.expiresAt.getTime());
    expect(row.revokedAt).toBeNull();
    expect(row.lastSeenAt).toBeNull();
  });
  it('rejects disabled users without writing a session', async () => {
    const id = await user('DISABLED');
    await expect(service.createSession(id)).rejects.toMatchObject({ code: 'USER_DISABLED' });
    expect(await db.session.count({ where: { userId: id } })).toBe(0);
  });
  it('rejects missing users', async () => {
    await expect(service.createSession(randomUUID())).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
  it('preserves the database unique digest invariant', async () => {
    const id = await user(),
      result = await service.createSession(id),
      row = await rowFor(result.sessionId);
    await expect(
      db.session.create({
        data: { userId: id, tokenHash: row.tokenHash, expiresAt: row.expiresAt },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  it('resolves only minimal identity and never updates lastSeenAt or expiry', async () => {
    const id = await user(),
      result = await service.createSession(id);
    const first = await service.validateSession(result.token);
    time += 1000;
    const second = await service.validateSession(result.token);
    expect(Object.keys(first).sort()).toEqual(['expiresAt', 'sessionId', 'userId']);
    expect(first.userId).toBe(id);
    expect(first.sessionId).toBe(result.sessionId);
    expect(JSON.stringify(first).includes(result.token)).toBe(false);
    expect(second.expiresAt.getTime()).toBe(epoch + lifetime);
    expect((await rowFor(result.sessionId)).lastSeenAt).toBeNull();
  });
  it('rejects unknown and malformed tokens', async () => {
    await expect(service.validateSession(generateSessionToken())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(service.validateSession('malformed')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
  it('accepts just before expiry and rejects exactly at and after expiry', async () => {
    const result = await service.createSession(await user());
    time = epoch + lifetime - 1;
    expect((await service.validateSession(result.token)).sessionId).toBe(result.sessionId);
    for (const offset of [0, 1]) {
      time = epoch + lifetime + offset;
      await expect(service.validateSession(result.token)).rejects.toMatchObject({
        code: 'SESSION_EXPIRED',
      });
    }
    await db.session.update({
      where: { id: result.sessionId },
      data: { lastSeenAt: new Date(time) },
    });
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
  it('enforces current user status on every validation', async () => {
    const id = await user(),
      result = await service.createSession(id);
    await service.validateSession(result.token);
    await db.user.update({ where: { id }, data: { status: 'DISABLED' } });
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'USER_DISABLED',
    });
  });
  it('revokes individually and preserves the timestamp across repeats', async () => {
    const id = await user(),
      result = await service.createSession(id);
    time += 100;
    expect(await service.revokeSession(result.sessionId, id)).toEqual({ revoked: true });
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    time += 100;
    expect(await service.revokeSession(result.sessionId, id)).toEqual({ revoked: false });
    expect((await rowFor(result.sessionId)).revokedAt.getTime()).toBe(epoch + 100);
  });
  it('rejects cross-user and nonexistent revocation without changing the target', async () => {
    const owner = await user(),
      other = await user(),
      result = await service.createSession(owner);
    await expect(service.revokeSession(result.sessionId, other)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(service.revokeSession(randomUUID(), owner)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect((await service.validateSession(result.token)).userId).toBe(owner);
  });
  it('does not resurrect revoked sessions when user is re-enabled or lastSeenAt changes', async () => {
    const id = await user(),
      result = await service.createSession(id);
    await service.revokeSession(result.sessionId, id);
    await db.user.update({ where: { id }, data: { status: 'DISABLED' } });
    await db.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    await db.session.update({
      where: { id: result.sessionId },
      data: { lastSeenAt: new Date(time + 10) },
    });
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });
  it('restores an unrevoked session when a disabled user is re-enabled, without extending expiry', async () => {
    // Documented limitation: disabling is not implicit revocation. This test pins
    // the behaviour in both directions so a future change cannot silently alter it.
    const id = await user(),
      result = await service.createSession(id);
    await db.user.update({ where: { id }, data: { status: 'DISABLED' } });
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'USER_DISABLED',
    });

    await db.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    const restored = await service.validateSession(result.token);
    expect(restored.userId).toBe(id);
    expect(restored.expiresAt.getTime()).toBe(epoch + lifetime);
    expect((await rowFor(result.sessionId)).revokedAt).toBeNull();

    // The absolute expiry is unaffected by the re-enable.
    time = epoch + lifetime;
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
  it('revoke-all targets only active unrevoked sessions and preserves history and other users', async () => {
    const id = await user(),
      other = await user();
    const expired = await service.createSession(id);
    time += lifetime;
    const old = await service.createSession(id);
    await service.revokeSession(old.sessionId, id);
    const a = await service.createSession(id),
      b = await service.createSession(id),
      untouched = await service.createSession(other);
    time += 1;
    expect(await service.revokeAllUserSessions(id)).toEqual({ revokedCount: 2 });
    expect(await service.revokeAllUserSessions(id)).toEqual({ revokedCount: 0 });
    expect((await rowFor(old.sessionId)).revokedAt.getTime()).toBe(epoch + lifetime);
    expect((await rowFor(expired.sessionId)).revokedAt).toBeNull();
    for (const token of [a.token, b.token])
      await expect(service.validateSession(token)).rejects.toMatchObject({
        code: 'SESSION_REVOKED',
      });
    expect((await service.validateSession(untouched.token)).userId).toBe(other);
  });
  it('creates unique secrets and rows concurrently', async () => {
    const id = await user();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.createSession(id)));
    expect(new Set(results.map((x) => x.token)).size).toBe(8);
    expect(new Set(results.map((x) => x.sessionId)).size).toBe(8);
    expect(await db.session.count({ where: { userId: id } })).toBe(8);
  });
  it('concurrent revocations change the timestamp only once', async () => {
    const id = await user(),
      result = await service.createSession(id);
    const outcomes = await Promise.all([
      service.revokeSession(result.sessionId, id),
      service.revokeSession(result.sessionId, id),
    ]);
    expect(outcomes.filter((x) => x.revoked).length).toBe(1);
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });
  it('creation racing with disable may insert but cannot validate a disabled identity', async () => {
    const id = await user();
    const racing = new SessionService(
      {
        user: {
          findUnique: async (args) => {
            const read = await db.user.findUnique(args);
            await db.user.update({ where: { id }, data: { status: 'DISABLED' } });
            return read;
          },
        },
        session: db.session,
      },
      () => new Date(time),
    );
    const result = await racing.createSession(id);
    await expect(service.validateSession(result.token)).rejects.toMatchObject({
      code: 'USER_DISABLED',
    });
  });
  it('documents that creation after the revoke-all statement can remain valid', async () => {
    const id = await user();
    let count;
    const racing = new SessionService(
      {
        user: db.user,
        session: {
          create: async (args) => {
            count = (await service.revokeAllUserSessions(id)).revokedCount;
            return db.session.create(args);
          },
        },
      },
      () => new Date(time),
    );
    const result = await racing.createSession(id);
    expect(count).toBe(0);
    expect((await service.validateSession(result.token)).userId).toBe(id);
  });
});
