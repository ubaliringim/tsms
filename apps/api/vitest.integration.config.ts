import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/support/dist-freshness.mjs'],
    include: ['tests/**/*.integration.test.mjs'],
    setupFiles: ['../../packages/database/tests/setup.mjs', './tests/support/track-requests.mjs'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
