import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeDatabase, createDatabaseClient, pingDatabase } from '../dist/client.js';
import { assertDisposableTestDatabase } from '../dist/testing.js';

// Prisma Migrate records applied migrations in this table.
const MIGRATION_TABLE = '_prisma_migrations';

let client;
let url;

beforeAll(() => {
  const integration = parseIntegrationEnvironment(process.env);
  url = assertDisposableTestDatabase(integration.TEST_DATABASE_URL);
  client = createDatabaseClient(url, { connectionTimeoutMillis: 5_000 });
});

afterAll(async () => {
  if (client) {
    await closeDatabase(client);
  }
});

describe('database integration against a real PostgreSQL instance', () => {
  it('connects and answers a raw query', async () => {
    await expect(pingDatabase(client)).resolves.toBeUndefined();
  });

  it('is at the expected migration state', async () => {
    const applied = await client.$queryRawUnsafe(
      `SELECT migration_name FROM ${MIGRATION_TABLE} WHERE finished_at IS NOT NULL ORDER BY started_at`,
    );
    const names = applied.map((row) => row.migration_name);
    expect(names).toEqual([
      '20261007121807_init_infrastructure_probe',
      '20261007121808_enable_pgvector',
    ]);
  });

  it('has no failed migration left behind', async () => {
    const failed = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM ${MIGRATION_TABLE} WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`,
    );
    expect(failed[0].count).toBe(0);
  });

  it('has the pgvector extension available without any vector business table', async () => {
    const rows = await client.$queryRawUnsafe(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);

    const vectorTables = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE udt_name = 'vector'`,
    );
    expect(vectorTables[0].count).toBe(0);
  });

  it('round-trips a record through the typed query layer', async () => {
    const label = `probe-${process.pid}-${Date.now()}`;
    const created = await client.infrastructureProbe.create({ data: { label } });
    try {
      expect(created.id).toBeGreaterThan(0);
      const found = await client.infrastructureProbe.findUnique({ where: { label } });
      expect(found?.label).toBe(label);
      expect(found?.createdAt).toBeInstanceOf(Date);
    } finally {
      await client.infrastructureProbe.delete({ where: { label } });
    }
    expect(await client.infrastructureProbe.findUnique({ where: { label } })).toBeNull();
  });

  it('enforces the schema unique constraint', async () => {
    const label = `probe-unique-${process.pid}-${Date.now()}`;
    await client.infrastructureProbe.create({ data: { label } });
    try {
      await expect(client.infrastructureProbe.create({ data: { label } })).rejects.toThrow();
    } finally {
      await client.infrastructureProbe.deleteMany({ where: { label } });
    }
  });

  it('commits and rolls back through $transaction', async () => {
    const committed = `probe-commit-${process.pid}-${Date.now()}`;
    const rolledBack = `probe-rollback-${process.pid}-${Date.now()}`;

    await client
      .$transaction(async (tx) => {
        await tx.infrastructureProbe.create({ data: { label: committed } });
        await tx.infrastructureProbe.create({ data: { label: rolledBack } });
        // Throwing must undo the whole transaction, including the first insert.
        throw new Error('rollback');
      })
      .catch((error) => {
        expect(error.message).toBe('rollback');
      });

    try {
      expect(
        await client.infrastructureProbe.findUnique({ where: { label: committed } }),
      ).toBeNull();
      expect(
        await client.infrastructureProbe.findUnique({ where: { label: rolledBack } }),
      ).toBeNull();
    } finally {
      await client.infrastructureProbe.deleteMany({ where: { label: { startsWith: 'probe-' } } });
    }
  });

  it('closes the connection pool and tolerates a second close', async () => {
    const disposable = createDatabaseClient(url, { connectionTimeoutMillis: 5_000 });
    await pingDatabase(disposable);
    await closeDatabase(disposable);
    await expect(closeDatabase(disposable)).resolves.toBeUndefined();
  });

  it('reports an unreachable database as a failure rather than succeeding', async () => {
    const unreachable = createDatabaseClient(url.replace('5432', '5433'), {
      connectionTimeoutMillis: 2_000,
    });
    try {
      await expect(pingDatabase(unreachable)).rejects.toBeDefined();
    } finally {
      await closeDatabase(unreachable);
    }
  });
});
