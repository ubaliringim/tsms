import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  closeDatabase,
  createDatabaseClient,
  pingDatabase,
  type PrismaClient,
} from '@tsms/database';

/** Readiness outcome for one dependency. Deliberately coarse: no driver text. */
export type DependencyState = 'up' | 'down';

/**
 * Owns the process-wide Prisma client.
 *
 * Lifecycle rules:
 *   - One client per process. NestJS is a singleton container, so creating a
 *     client per request would mean a new connection pool per request.
 *   - The pool is released on application shutdown.
 *   - Connections are established lazily by the driver, so the process still
 *     starts and still reports liveness when PostgreSQL is unavailable.
 *
 * Tenant scoping is not implemented here and must not be added to this class.
 * Stage 3 scopes school-owned rows through tenant-aware repositories, which take
 * both a client (or transaction client) and trusted tenant context.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = createDatabaseClient(databaseUrl, { connectionTimeoutMillis: 5_000 });
  }

  get prisma(): PrismaClient {
    return this.client;
  }

  async check(): Promise<DependencyState> {
    try {
      await pingDatabase(this.client);
      return 'up';
    } catch {
      // The driver error can echo connection details. Readiness must not.
      return 'down';
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await closeDatabase(this.client);
  }
}
