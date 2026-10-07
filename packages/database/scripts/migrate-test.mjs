#!/usr/bin/env node
// Apply committed migrations to the disposable test database using the same
// `prisma migrate deploy` command that staging and production use.
//
// Why a script instead of `DATABASE_URL=... prisma migrate deploy`:
//   - That form depends on shell-specific environment assignment, which is not
//     portable across Windows and POSIX.
//   - It would bypass the safety guard that keeps destructive work off the
//     application database.
//
// Usage: pnpm --filter @tsms/database db:test:migrate

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntegrationEnvironment } from '@tsms/config';
import { assertDisposableTestDatabase } from '../dist/testing.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryEnv = resolve(packageRoot, '../../.env');

if (existsSync(repositoryEnv)) {
  process.loadEnvFile(repositoryEnv);
}
process.env.NODE_ENV = 'test';

const integration = parseIntegrationEnvironment(process.env);
const url = assertDisposableTestDatabase(integration.TEST_DATABASE_URL);

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

// `process.loadEnvFile` in prisma.config.ts does not override variables that are
// already set, so passing DATABASE_URL below reliably wins over the repository
// `.env` in the child process.
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: packageRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: url },
});

if (result.error) {
  console.error('Failed to run prisma migrate deploy against the test database.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
