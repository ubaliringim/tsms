# TSMS project state

Project: TSMS - TeamStack School Management System

Company: TeamStack Technologies LTD

Updated: 2026-10-07

Phase: Foundation

Stage: 2 - Authentication & Identity

Stage status: AUTHORIZED, not accepted. Owner approved Specification v1.0.

Current substage: 2.1 - Identity Schema & Migration (OWNER-ACCEPTED LOCALLY, SUBJECT TO HOSTED CI VERIFICATION). Authorization is limited to 2.1.

Stage 1 status: ACCEPTED by the project owner on 2026-10-07.

Stage 0 status: ACCEPTED (owner decision, 2026-10-07). Record at tasks/completed/stage-0-engineering-foundation.md.

Next substage: 2.2 - Password Credential Service. NOT authorized; hard stop after 2.1.

Accepted capabilities: PostgreSQL local infrastructure, Redis local infrastructure, pgvector extension foundation, Prisma 7 database foundation, packages/database, packages/redis, migration workflow, database and Redis lifecycle handling, API and worker liveness/readiness separation, integration-test infrastructure, test-database safety controls, Docker Compose workflow, fresh-state reproducibility, the Stage 1 CI workflow, the three Prisma dependency security remediations, the temporary InfrastructureProbe scaffolding, and the smoke-test readiness extensions. The Stage 1 known issues were reviewed and accepted as non-blocking.

Security: Two open high-severity dependency advisories from Stage 0 (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm) retain owner-approved temporary dispositions based on documented non-reachability. Both remain UNRESOLVED: both packages are still installed, both vulnerable code paths are still present on disk, and neither has a patched upstream release. Stage 1 introduced three further advisories through Prisma (deepmerge-ts, mysql2 twice); all three had patched releases and were REMEDIATED via scoped overrides, not accepted. The overrides are scoped to their introducing Prisma parent ('@prisma/config>deepmerge-ts' and 'prisma>mysql2'), and the pre-override versions were proven unreachable and removed from disk; the installed graph was re-confirmed at Stage 1 acceptance. See docs/security/DEPENDENCY_RISK_REGISTER.md.

Audit status: `pnpm audit --audit-level=high` still FAILS with two high findings, unchanged from the Stage 0 baseline. No advisory is suppressed, no threshold is lowered, no broad ignore rule exists, and no security-exception framework has been introduced. In CI the raw audit runs in a dedicated security-audit job so a functional regression and the known security-policy gate are separately attributable. That job still fails, so the workflow still reports red.

Historical Stage 1 acceptance validation: Frozen install, format, lint, typecheck, 47 unit tests, builds, 17 Docker-requiring integration tests, 16 smoke assertions (both with infrastructure up and with it stopped), mobile dependency check, mobile Android export, Prisma validate/generate/format-check/migrate status, fresh-database migration, volume persistence, a forced no-cache build from a fresh checkout, and a full fresh-state infrastructure rebuild. `pnpm audit --audit-level=high` fails as expected.

Post-acceptance hosted CI repair (2026-10-07): Stage 1 was committed and pushed as `635536b`. Its first hosted Linux run failed unexpectedly in integration setup, while the separate raw security audit failed as expected. The workflow already declares valid disposable test URLs, but Turbo strict mode filtered both out because the integration task did not declare them. Local `.env` loading masked the defect. Reproduction without `.env` confirmed migration succeeds outside Turbo, then Vitest fails with `Invalid environment configuration: TEST_DATABASE_URL, TEST_REDIS_URL`. The repair adds only those two names to `tasks.test:integration.env` in `turbo.json`; strict mode, configuration validation, safety guards, migrations, and workflow audit behavior are unchanged. Stage 1 remains ACCEPTED. Repair validation and follow-up warnings are recorded in `tasks/completed/stage-1-hosted-ci-repair.md`; repair commit `ceffd2e` is now owner-verified on hosted Linux GitHub Actions: `validate` PASS, `security-audit` FAIL as expected on exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. Hosted verification is complete and the repair is CLOSED; the overall workflow remains red because of the unsuppressed audit.

Closure validation (2026-10-07) found and fixed two real Stage 1 defects before acceptance: a fresh checkout could not build because Prisma Client generation was not part of the database package build, and `pnpm infra:up` returned a non-zero exit code because Compose treats the one-shot test-database init container as a failure. Both were fixed and re-verified.

Stage 2.1 implementation: six global identity persistence models, native UUID columns with Prisma UUIDv7 defaults, unique normalized email and hash fields, one credential per user, explicit restrictive foreign keys, lifecycle timestamps, and a new forward migration. InfrastructureProbe is retained for independent Stage 1 regression tests. No accepted migration is changed. Validation passed: 47 unit/toolchain tests, 43 integration tests (26 new), 16 smoke assertions, builds, mobile dependency check/export, and a fresh three-migration replay with no schema drift. The audit still fails on exactly the known two high advisories. See tasks/CURRENT.md for commands, outcomes, and limitations.

Not implemented: authentication behavior, password hashing, login/logout, sessions/cookies/middleware, token generation or consumption, recovery/email delivery, UI, tenants, memberships, roles, permissions, or other product functionality. No authentication dependencies added.

Version-control handoff: owner authorized committing the ten reviewed Stage 2.1/state files as `feat: add authentication identity schema` and pushing main to origin after all eight boundary checks pass. All eight passed, including a refreshed audit with exactly the two known high advisories. Hosted verification is pending at preparation.

Validation limitation: forced parallel checking exposed concurrent Prisma generation in the existing build/typecheck scripts (EEXIST). The uncached serial check and ordinary default check passed; task configuration is unchanged. Track coordinated generation as a separate tooling follow-up. Hosted Stage 2.1 CI and native device/store builds have not run.

Exact next action: create the authorized commit, push main without force, inspect hosted CI, record actual results, then stop. Stage 2.1 is owner-accepted locally subject to hosted verification. Stage 2 is not accepted; Stage 2.2 is NOT authorized. Retain the unresolved advisory, scoped override, Actions runtime, and Ubuntu runner follow-ups.

DO NOT: start Stage 2.2 or later, implement authentication behavior or tenant/RBAC functionality, install authentication dependencies, suppress or weaken audit controls, mark accepted advisories resolved, rewrite accepted migrations, amend accepted commits, force push, or deploy.

Current evidence and handoff: tasks/CURRENT.md. Historical Stage 1 acceptance: tasks/completed/stage-1-database-and-local-infrastructure.md. Security dispositions, owner decisions, and audit policy: docs/security/DEPENDENCY_RISK_REGISTER.md. Database and infrastructure implementation: docs/architecture/DATABASE.md and infrastructure/README.md. Toolchain compatibility: docs/architecture/DEPENDENCY_REVIEW.md.
