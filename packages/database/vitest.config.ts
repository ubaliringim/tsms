import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Integration tests require the Docker Compose services and run through
    // `pnpm test:integration`. They must not run as part of the ordinary
    // unit-test command, so no developer needs Docker to run `pnpm test`.
    exclude: ['tests/**/*.integration.test.mjs'],
  },
});
