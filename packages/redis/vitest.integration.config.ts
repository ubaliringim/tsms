import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    include: ['tests/**/*.integration.test.mjs'],
    setupFiles: ['tests/setup.mjs'],
  },
});
