// Prisma CLI configuration for the canonical TSMS database package.
//
// Prisma 7 reads CLI configuration from this file rather than from a `prisma`
// key in package.json. Paths are resolved relative to this file.
//
// The repository root `.env` is loaded explicitly with Node's built-in loader
// so that `pnpm --filter @tsms/database db:*` behaves the same way the API and
// worker do, without adding a dotenv dependency. Values already present in the
// environment win, so CI and container environments are unaffected.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryEnv = resolve(here, '../../.env');

if (existsSync(repositoryEnv)) {
  process.loadEnvFile(repositoryEnv);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Read directly rather than through Prisma's `env()` helper: `prisma generate`
    // and `prisma validate` do not need a database URL and must keep working in
    // environments that have no database. Commands that actually connect fail
    // with Prisma's own error when the URL is absent.
    url: process.env.DATABASE_URL ?? '',
  },
});
