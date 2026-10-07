import { PrismaPg } from '@prisma/adapter-pg';
import type { Prisma } from './generated/prisma/client.js';
import { PrismaClient } from './generated/prisma/client.js';

/**
 * The generated Prisma Client is re-exported through this module so that no
 * application or worker imports the `src/generated` tree directly.
 *
 * `DatabaseTransactionClient` is exported for Stage 3: tenant-aware repositories
 * must accept both a pooled client and a transaction client, and typing them
 * against this package keeps generated internals out of the domain layers.
 */
export { Prisma, PrismaClient };
export type DatabaseTransactionClient = Prisma.TransactionClient;

export type DatabaseLogLevel = 'query' | 'info' | 'warn' | 'error';

export interface CreateDatabaseClientOptions {
  /**
   * Prisma log levels. Defaults to no logging so that a failure never writes a
   * raw driver error containing connection details to stdout.
   */
  readonly log?: readonly DatabaseLogLevel[];
  /**
   * TCP connect timeout in milliseconds. Prisma 7 delegates to the `pg` driver,
   * whose default is no timeout, which would let a readiness probe hang against
   * a black-holed address.
   */
  readonly connectionTimeoutMillis?: number;
}

/**
 * Create a Prisma client bound to one PostgreSQL database.
 *
 * A single client is intended per application process: it owns a connection pool
 * and is safe to share across concurrent requests. Callers own the returned
 * client and must call `closeDatabase` during shutdown.
 *
 * Tenant scoping is deliberately not implemented here. Shared-schema
 * multi-tenancy (ADR-002) scopes school-owned rows with a `tenantId` column, so
 * the client itself needs no per-tenant variant and no request-bound client.
 */
export function createDatabaseClient(
  connectionString: string,
  options: CreateDatabaseClientOptions = {},
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
  });
  return new PrismaClient({
    adapter,
    log: options.log ? [...options.log] : [],
  });
}

/**
 * Verify the database is reachable. Throws on failure; callers decide how to
 * report it. This never returns the underlying driver error text.
 */
export async function pingDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

/** Release the connection pool. Safe to call more than once. */
export async function closeDatabase(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}
