import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one disposable database, so they run serially.
    fileParallelism: false,
    include: ['tests/**/*.integration.test.mjs'],
    setupFiles: ['tests/setup.mjs'],
  },
});
