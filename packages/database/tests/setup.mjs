// Loads the repository `.env` for integration tests and pins NODE_ENV=test.
// Registered through `vitest.integration.config.ts` only, so the ordinary
// unit-test command never requires local infrastructure configuration.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryEnv = resolve(import.meta.dirname, '../../../.env');

if (existsSync(repositoryEnv)) {
  process.loadEnvFile(repositoryEnv);
}
process.env.NODE_ENV = 'test';
