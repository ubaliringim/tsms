import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Structural regression coverage for the concurrent Prisma generation incident.
 *
 * Hosted run 37860601281 failed `pnpm check` with
 *   TS6053: File 'packages/database/src/generated/prisma/client.ts' not found
 * because `@tsms/database:build` and `@tsms/database:typecheck` each ran
 * `prisma generate` into the same directory concurrently, and one task's `tsc` read the
 * directory while the other was rewriting it.
 *
 * These assertions read the real task graph and package scripts, so they fail the moment the
 * graph regresses. They are deliberately structural rather than timing-based: reproducing the
 * original failure reliably would require sleeping and would itself be flaky.
 */

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const read = (relative) => readFileSync(resolve(repositoryRoot, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

const turbo = readJson('turbo.json');
const database = readJson('packages/database/package.json');

/** Every workspace package that declares a script of the given name. */
const packagesWithScript = (name) =>
  [
    'apps/api',
    'apps/worker',
    'apps/web',
    'apps/control',
    'apps/student-mobile',
    'packages/config',
    'packages/database',
    'packages/redis',
  ].flatMap((pkg) => {
    let manifest;
    try {
      manifest = readJson(`${pkg}/package.json`);
    } catch {
      return [];
    }
    const command = manifest.scripts?.[name];
    return command === undefined ? [] : [`${pkg} :: ${name} = ${command}`];
  });

describe('Prisma Client generation ownership', () => {
  it('gives generation a single task owner in the build graph', () => {
    expect(turbo.tasks['db:generate']).toBeDefined();
    // Present in the database package and nowhere else.
    expect(packagesWithScript('db:generate')).toEqual([
      'packages/database :: db:generate = prisma generate',
    ]);
  });

  it('never lets the database build or typecheck script regenerate the client', () => {
    // This is the exact defect that caused the incident. Both scripts used to begin with
    // `prisma generate &&`, so two independent Turbo tasks wrote the same directory at once.
    expect(database.scripts.build).not.toMatch(/prisma/);
    expect(database.scripts.typecheck).not.toMatch(/prisma/);
    expect(database.scripts.build).toBe('tsc -p tsconfig.json');
    expect(database.scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');
  });

  it('leaves no other script in the workspace that writes generated Prisma output', () => {
    const writers = [
      ...packagesWithScript('build'),
      ...packagesWithScript('typecheck'),
      ...packagesWithScript('test'),
      ...packagesWithScript('prebuild'),
      ...packagesWithScript('postinstall'),
    ].filter((entry) => /prisma\s+generate/.test(entry));
    expect(writers).toEqual([]);
  });

  it('makes build and typecheck depend on generation so readers are ordered after it', () => {
    expect(turbo.tasks.build.dependsOn).toContain('db:generate');
    expect(turbo.tasks.typecheck.dependsOn).toContain('db:generate');
    // The existing cross-package ordering must survive.
    expect(turbo.tasks.build.dependsOn).toContain('^build');
    expect(turbo.tasks.typecheck.dependsOn).toContain('^build');
  });

  it('reaches generation transitively from every task that compiles generated files', () => {
    // test and test:integration depend on build, which depends on db:generate.
    expect(turbo.tasks.test.dependsOn).toContain('build');
    expect(turbo.tasks['test:integration'].dependsOn).toContain('build');
    expect(turbo.tasks.dev.dependsOn).toContain('^build');
  });

  it('disables caching for generation so a partial cache cannot masquerade as success', () => {
    expect(turbo.tasks['db:generate'].cache).toBe(false);
  });

  it('does not introduce migrations into generation, build, or typecheck', () => {
    expect(database.scripts['db:generate']).toBe('prisma generate');
    for (const name of ['build', 'typecheck']) {
      expect(database.scripts[name]).not.toMatch(/migrate/);
    }
    expect(database.scripts['db:generate']).not.toMatch(/migrate/);
  });

  it('keeps the generated client out of version control and points the generator at it', () => {
    expect(read('.gitignore')).toMatch(/packages\/database\/src\/generated/);
    expect(read('packages/database/prisma/schema.prisma')).toMatch(
      /output\s*=\s*"\.\.\/src\/generated\/prisma"/,
    );
  });

  it('tracks every documented API configuration variable as a global env', () => {
    // A variable that changes behaviour but is absent from globalEnv cannot change a Turbo
    // cache key, which lets a stale task result be reused across configurations.
    for (const key of [
      'API_TRUSTED_ORIGINS',
      'API_PASSWORD_RECOVERY_DELIVERY_MODE',
      'API_PASSWORD_RECOVERY_URL_BASE',
    ]) {
      expect(turbo.globalEnv, `${key} missing from turbo globalEnv`).toContain(key);
      expect(read('.env.example'), `${key} missing from .env.example`).toContain(key);
    }
  });
});
