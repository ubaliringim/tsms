import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeDatabase, createDatabaseClient } from '../dist/client.js';
import { assertDisposableTestDatabase } from '../dist/testing.js';

let client;
const userIds = [];
const eventIds = [];
const expiresAt = new Date('2030-01-02T00:00:00.000Z');
const lifecycleAt = new Date('2030-01-01T12:00:00.000Z');
// Inert synthetic persistence fixtures, not generated bearer tokens or passwords.
const tokenHash = 'a'.repeat(64);
const passwordHash = 'synthetic-non-authenticating-hash';
const tokenModels = ['session', 'passwordResetToken', 'emailVerificationToken'];
const dependentModels = ['passwordCredential', ...tokenModels, 'authenticationEvent'];

beforeAll(() => {
  const integration = parseIntegrationEnvironment(process.env);
  const url = assertDisposableTestDatabase(integration.TEST_DATABASE_URL);
  client = createDatabaseClient(url, { connectionTimeoutMillis: 5_000 });
});

afterEach(async () => {
  if (!client) return;
  // Deliberate child-first fixture cleanup; no cascading delete or broad truncate.
  await client.authenticationEvent.deleteMany({ where: { id: { in: eventIds } } });
  for (const model of dependentModels) {
    await client[model].deleteMany({ where: { userId: { in: userIds } } });
  }
  await client.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
  eventIds.length = 0;
});

afterAll(async () => {
  if (client) await closeDatabase(client);
});

async function createUser(overrides = {}) {
  const email = `identity-${randomUUID()}@example.test`;
  const user = await client.user.create({
    data: { email, normalizedEmail: email, displayName: 'Synthetic Identity', ...overrides },
  });
  userIds.push(user.id);
  return user;
}

function dependentData(model, userId) {
  if (model === 'passwordCredential') return { userId, passwordHash };
  if (model === 'authenticationEvent') return { userId, eventType: 'LOGIN_FAILED' };
  return { userId, tokenHash, expiresAt };
}

describe('Stage 2.1 identity persistence (no authentication behavior)', () => {
  it('persists a global unverified identity with a generated UUIDv7 and timestamps', async () => {
    const email = `Presentation-${randomUUID()}@Example.Test`;
    const created = await createUser({ email, normalizedEmail: email.toLowerCase() });
    const found = await client.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(found.email).toBe(email);
    expect(found.normalizedEmail).toBe(email.toLowerCase());
    expect(found.displayName).toBe('Synthetic Identity');
    expect(found.status).toBe('ACTIVE');
    expect(found.emailVerifiedAt).toBeNull();
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects a second presentation email with the same normalized email at the database', async () => {
    const user = await createUser();
    // Direct SQL proves uniqueness is a database constraint, not a client check.
    await expect(client.$executeRaw`
      INSERT INTO users (id, email, "normalizedEmail", "displayName", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${user.email.toUpperCase()}, ${user.normalizedEmail}, 'Synthetic', NOW())
    `).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
    });
  });

  it('persists disabled status and verification time, and advances updatedAt on edits', async () => {
    const oldTime = new Date('2000-01-01T00:00:00.000Z');
    const user = await createUser({ updatedAt: oldTime });
    await client.user.update({
      where: { id: user.id },
      data: { status: 'DISABLED', emailVerifiedAt: lifecycleAt },
    });
    const found = await client.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(found.status).toBe('DISABLED');
    expect(found.emailVerifiedAt).toEqual(lifecycleAt);
    expect(found.updatedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it('rejects an unapproved user status in PostgreSQL', async () => {
    const user = await createUser();
    await expect(client.$executeRaw`
      UPDATE users SET status = 'PENDING' WHERE id = ${user.id}::uuid
    `).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '22P02' } } },
    });
  });

  it('allows one required password hash per user and persists credential timestamps', async () => {
    const user = await createUser();
    const credential = await client.passwordCredential.create({
      data: { userId: user.id, passwordHash, passwordChangedAt: lifecycleAt },
    });
    const found = await client.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(found.id).toBe(credential.id);
    expect(found.passwordHash).toBe(passwordHash);
    expect(found.passwordChangedAt).toEqual(lifecycleAt);
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
    await expect(
      client.passwordCredential.create({
        data: { userId: user.id, passwordHash },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a missing password hash through direct SQL', async () => {
    const user = await createUser();
    await expect(client.$executeRaw`
      INSERT INTO password_credentials (id, "userId", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${user.id}::uuid, NOW())
    `).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23502' } } },
    });
  });

  it.each(tokenModels)('%s enforces globally unique token hashes across users', async (model) => {
    const first = await createUser();
    const second = await createUser();
    await client[model].create({ data: dependentData(model, first.id) });
    await expect(
      client[model].create({ data: dependentData(model, second.id) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it.each(tokenModels)(
    '%s persists ownership, expiry, and its lifecycle markers',
    async (model) => {
      const user = await createUser();
      const created = await client[model].create({ data: dependentData(model, user.id) });
      if (model === 'session') {
        expect(created.lastSeenAt).toBeNull();
        expect(created.revokedAt).toBeNull();
      } else {
        expect(created.usedAt).toBeNull();
      }
      const markers =
        model === 'session'
          ? { lastSeenAt: lifecycleAt, revokedAt: lifecycleAt }
          : { usedAt: lifecycleAt };
      await client[model].update({ where: { id: created.id }, data: markers });
      const found = await client[model].findUniqueOrThrow({
        where: { tokenHash },
        include: { user: true },
      });
      expect(found.user.id).toBe(user.id);
      expect(found.expiresAt).toEqual(expiresAt);
      expect(found.createdAt).toBeInstanceOf(Date);
      expect(found).toMatchObject(markers);
    },
  );

  it('persists a known-user security event and its correlation/time fields', async () => {
    const user = await createUser();
    const event = await client.authenticationEvent.create({
      data: {
        userId: user.id,
        eventType: 'EMAIL_VERIFIED',
        occurredAt: lifecycleAt,
        requestId: randomUUID(),
      },
    });
    const found = await client.authenticationEvent.findUniqueOrThrow({
      where: { id: event.id },
      include: { user: true },
    });
    expect(found.user.id).toBe(user.id);
    expect(found.eventType).toBe('EMAIL_VERIFIED');
    expect(found.requestId).toBe(event.requestId);
    expect(found.occurredAt).toEqual(lifecycleAt);
  });

  it('persists a pre-identity event without manufacturing a user', async () => {
    const event = await client.authenticationEvent.create({ data: { eventType: 'LOGIN_FAILED' } });
    eventIds.push(event.id);
    const found = await client.authenticationEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(found.userId).toBeNull();
    expect(found.requestId).toBeNull();
    expect(found.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects arbitrary security event types in PostgreSQL', async () => {
    await expect(client.$executeRaw`
      INSERT INTO authentication_events (id, "eventType") VALUES (${randomUUID()}::uuid, 'REQUEST_DUMP')
    `).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '22P02' } } },
    });
  });

  it.each(dependentModels)(
    '%s rejects a nonexistent user through its foreign key',
    async (model) => {
      await expect(
        client[model].create({ data: dependentData(model, randomUUID()) }),
      ).rejects.toMatchObject({ code: 'P2003' });
    },
  );

  it.each(dependentModels)(
    '%s prevents deletion or ID mutation of its user and retains the child',
    async (model) => {
      const user = await createUser();
      const child = await client[model].create({ data: dependentData(model, user.id) });
      await expect(client.user.delete({ where: { id: user.id } })).rejects.toMatchObject({
        code: 'P2003',
      });
      await expect(
        client.user.update({ where: { id: user.id }, data: { id: randomUUID() } }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await client[model].findUnique({ where: { id: child.id } })).toMatchObject({
        userId: user.id,
      });
      expect(await client.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    },
  );

  it('keeps the deployed schema within the identity boundary with no raw secrets or tenant/RBAC storage', async () => {
    const tables = await client.$queryRaw`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      '_prisma_migrations',
      'authentication_events',
      'email_verification_tokens',
      'infrastructure_probes',
      'password_credentials',
      'password_reset_tokens',
      'sessions',
      'users',
    ]);
    const columns = await client.$queryRaw`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const forbidden =
      /^(tenant_?id|school_?id|role|roles|permissions|class_?id|student_?id|teacher_?id|organization_?id|password|encrypted_?password|token|raw_?token|authorization|cookie|request_?body|metadata)$/i;
    expect(columns.filter((row) => forbidden.test(row.column_name))).toEqual([]);
  });
});
