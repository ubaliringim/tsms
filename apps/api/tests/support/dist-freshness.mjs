/**
 * Refuse to run API tests against compiled output that does not match the source.
 *
 * The API suites import from `../dist`, so they exercise whatever was last compiled, not what is in
 * `src`. The repository's `test` and `test:integration` tasks depend on `build` through Turborepo, but the
 * package-level commands (`pnpm --filter @tsms/api test:integration`, or `vitest` directly) do not. Run
 * that way after an edit, the suite passes against stale code and reports green for behaviour that was
 * never loaded - which happened during Stage 2.7, when 239 integration tests passed without a single line
 * of the new implementation in them.
 *
 * Timestamps are compared at full `mtimeMs` resolution, which NTFS and ext4 both keep; a coarser filesystem
 * (FAT, some network mounts) could report a false stale, which fails safe and is cured by a rebuild. A cache
 * restore that preserved old mtimes would behave the same way. Turborepo was observed to stamp restored
 * outputs with the restore time, so a cache hit passes.
 *
 * The check is deliberately mechanical rather than clever: every `src/**.ts` must have a compiled file at
 * least as new as itself, and every compiled file must still have a source. It fails with an instruction
 * instead of rebuilding, because silently compiling inside a test run would hide the very drift this
 * exists to expose.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = join(packageRoot, 'src');
const distRoot = join(packageRoot, 'dist');

/** Messages use forward slashes so they read, and compare, the same on Windows and Linux. */
const posix = (path) => path.split(sep).join('/');

function walk(directory, accept) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, accept));
    else if (accept(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Return a description of every way `dist` disagrees with `src`. Empty means current.
 *
 * Takes the roots as parameters so a unit test can point it at a fixture tree.
 */
export function distDrift(source = sourceRoot, dist = distRoot) {
  if (!existsSync(dist)) return ['dist is missing'];
  const problems = [];
  const sources = walk(source, (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
  const expected = new Set();
  for (const file of sources) {
    const compiled = join(dist, relative(source, file).replace(/\.ts$/, '.js'));
    expected.add(compiled);
    if (!existsSync(compiled)) problems.push(`not compiled: ${posix(relative(source, file))}`);
    else if (statSync(compiled).mtimeMs < statSync(file).mtimeMs)
      problems.push(`stale: ${posix(relative(source, file))}`);
  }
  for (const compiled of walk(dist, (name) => name.endsWith('.js'))) {
    if (!expected.has(compiled)) problems.push(`orphaned: ${posix(relative(dist, compiled))}`);
  }
  return problems;
}

export default function assertDistIsCurrent() {
  const problems = distDrift();
  if (problems.length > 0) {
    throw new Error(
      `apps/api/dist does not match apps/api/src, so these tests would not exercise the current code.\n` +
        `${problems.slice(0, 10).join('\n')}${problems.length > 10 ? `\n...and ${problems.length - 10} more` : ''}\n` +
        `Rebuild with "pnpm build" (or "pnpm --filter @tsms/api build") and rerun. ` +
        `Orphaned files mean a source file was deleted or renamed: remove the stale output in dist.`,
    );
  }
}
