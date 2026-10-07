# Verification strategy

Behavioral foundation tests live beside their owners: packages/config/tests, apps/api/tests, and apps/worker/tests. Vitest tests built JavaScript so API decorator behavior matches the TypeScript production build. Turbo builds dependencies and the tested package first.

scripts/smoke.mjs validates compiled entry points, web/Control routes, health responses, and fail-fast invalid environment handling; it owns and stops the processes it launches. Later stages add authorization, isolation, security, integration, and browser E2E coverage when corresponding behavior exists. No Playwright dependency is installed merely to test static placeholder text.

`tests/toolchain.test.mjs` exercises Expo config-plugins/xcode UUID generation after the scoped security override. It checks actual transitive-tool compatibility, not product functionality.
