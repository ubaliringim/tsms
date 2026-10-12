import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/support/dist-freshness.mjs'],
    exclude: ['**/node_modules/**', '**/*.integration.test.mjs'],
  },
});
