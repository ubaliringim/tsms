import { defineConfig } from '@playwright/test';

/**
 * Stage 2.8 browser suite. A real Chromium drives a real `next start` (production build) in front of a real API,
 * PostgreSQL, and Redis; see `e2e/global-setup.mjs`.
 *
 * It runs on its own Redis logical database, so it can reset the rate limiter without touching the state the
 * integration suites use. Generated output (reports, traces, results) lives under `test-results/` and
 * `playwright-report/`, both ignored by Git.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  globalSetup: './e2e/global-setup.mjs',
  // One worker: the suite shares one API, one database, and one limiter state.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    browserName: 'chromium',
    // Unset: Playwright's bundled Chromium (`playwright install chromium`, what a hosted runner uses).
    // `E2E_BROWSER_CHANNEL=chrome` drives an installed Google Chrome instead, for a machine that cannot
    // download the bundled build.
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
