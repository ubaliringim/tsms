import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseIntegrationEnvironment } from '@tsms/config';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../../api/dist/application.js';

/**
 * Starts the real chain for the browser suite and hands its coordinates to the test workers through the
 * environment (workers are forked after this runs, so they inherit it).
 *
 *   Chromium -> `next start` (production build) -> Nest API (in this process) -> PostgreSQL + Redis
 *
 * Isolation:
 *  - PostgreSQL: the guarded `_test` database; every test creates its own synthetic users and removes only them.
 *  - Redis: a DEDICATED logical database (`E2E_REDIS_DB`, default 2), never the one the integration suites use,
 *    so resetting the limiter between tests cannot disturb a concurrent suite.
 */

const root = resolve(import.meta.dirname, '..');
const repositoryEnv = resolve(root, '../../.env');
if (existsSync(repositoryEnv)) process.loadEnvFile(repositoryEnv);
process.env.NODE_ENV = 'test';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return port;
}

/** The test Redis URL, retargeted to the browser suite's own logical database. */
function e2eRedisUrl(testRedisUrl) {
  const index = Number(process.env.E2E_REDIS_DB ?? '2');
  const integrationIndex = Number(new URL(testRedisUrl).pathname.slice(1) || '0');
  if (!Number.isInteger(index) || index < 1 || index === integrationIndex) {
    throw new Error(
      'E2E_REDIS_DB must be a non-zero logical database different from TEST_REDIS_URL.',
    );
  }
  const url = new URL(testRedisUrl);
  // The suite resets limiter state, so it only ever runs against a Redis on this machine.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Refusing to run the browser suite: the test Redis host must be loopback.');
  }
  url.pathname = `/${index}`;
  return url.toString();
}

export default async function globalSetup() {
  const integrationEnv = parseIntegrationEnvironment(process.env);
  const databaseUrl = assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL);
  const redisUrl = e2eRedisUrl(integrationEnv.TEST_REDIS_URL);

  if (!existsSync(resolve(root, '.next/BUILD_ID'))) {
    throw new Error(
      'Run `pnpm --filter @tsms/web build` before the browser suite: no production build found.',
    );
  }

  const webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const api = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    API_TRUSTED_ORIGINS: [webOrigin],
    API_RATE_LIMIT_HMAC_SECRET: 'stage28_browser_suite_rate_limit_key_0123456789',
  });
  await api.listen(0, '127.0.0.1');
  const apiUrl = await api.getUrl();

  const nextBin = createRequire(resolve(root, 'package.json')).resolve('next/dist/bin/next');
  const web = spawn(
    process.execPath,
    [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        TSMS_API_ORIGIN: apiUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  for (const stream of [web.stdout, web.stderr]) {
    stream.on('data', (data) => {
      output = (output + data.toString()).slice(-8000);
    });
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (web.exitCode !== null) throw new Error(`next exited during startup: ${output}`);
    try {
      const response = await fetch(`${webOrigin}/`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) break;
    } catch {
      /* not accepting connections yet */
    }
    if (Date.now() > deadline) throw new Error(`next did not start: ${output}`);
    await delay(150);
  }

  process.env.E2E_WEB_ORIGIN = webOrigin;
  process.env.E2E_DATABASE_URL = databaseUrl;
  process.env.E2E_REDIS_URL = redisUrl;

  return async () => {
    if (web.exitCode === null) {
      web.kill();
      await once(web, 'exit').catch(() => undefined);
    }
    await api.close();
  };
}
