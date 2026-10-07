import { createServer, type Server } from 'node:http';
import { closeDatabase, createDatabaseClient, pingDatabase } from '@tsms/database';
import { closeRedis, createRedisClient, pingRedis } from '@tsms/redis';

export type DependencyState = 'up' | 'down';

export interface WorkerHealthDependencies {
  readonly database: DependencyState;
  readonly redis: DependencyState;
}

const READINESS_TIMEOUT_MILLIS = 2_000;

/**
 * Worker health and readiness surface.
 *
 * Stage 0 exposed process liveness only and deliberately had no infrastructure
 * connection. Stage 1 adds dependency readiness so an orchestrator can tell
 * "the process is alive" apart from "the process can do its work".
 *
 * The worker runs no queue yet, so readiness is served by the same small HTTP
 * server as liveness rather than by an additional monitoring server.
 */
export function createHealthServer(databaseUrl: string, redisUrl: string): Server {
  const database = createDatabaseClient(databaseUrl, { connectionTimeoutMillis: 5_000 });
  const redis = createRedisClient(redisUrl, { connectTimeoutMillis: READINESS_TIMEOUT_MILLIS });

  const checkDatabase = async (): Promise<DependencyState> => {
    try {
      await pingDatabase(database);
      return 'up';
    } catch {
      // Driver errors can echo connection details; readiness must not.
      return 'down';
    }
  };

  const checkRedis = async (): Promise<DependencyState> => {
    try {
      await pingRedis(redis, { timeoutMillis: READINESS_TIMEOUT_MILLIS });
      return 'up';
    } catch {
      // ioredis errors can contain the password; readiness must not.
      return 'down';
    }
  };

  let closing = false;

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'ok', service: 'tsms-worker' }));
      return;
    }

    if (request.method === 'GET' && request.url === '/ready') {
      void Promise.all([checkDatabase(), checkRedis()]).then(([databaseState, redisState]) => {
        const ready = databaseState === 'up' && redisState === 'up';
        response.writeHead(ready ? 200 : 503);
        response.end(
          JSON.stringify({
            status: ready ? 'ok' : 'degraded',
            service: 'tsms-worker',
            ready,
            dependencies: { database: databaseState, redis: redisState },
          }),
        );
      });
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ status: 'not_found' }));
  });

  // Release infrastructure connections exactly once, alongside the socket.
  const closeSocketServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    if (!closing) {
      closing = true;
      void Promise.all([closeDatabase(database), closeRedis(redis)]).catch(() => {
        // Shutdown must not fail because a dependency connection is already gone.
      });
    }
    return closeSocketServer(callback);
  };

  return server;
}
