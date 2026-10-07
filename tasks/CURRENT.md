# Current task: Stage 1 post-acceptance hosted CI repair closure

Authorized scope: documentation/state-only closure after owner-verified hosted CI at `ceffd2e`; leave changes uncommitted for owner review.

Status: CLOSED - hosted verification complete at `ceffd2e`. Owner-verified `validate` PASS; `security-audit` FAIL as expected. The overall workflow remains red.

Stage: 1 - Database & Local Infrastructure - **ACCEPTED** (owner decision, 2026-10-07)

Next planned stage: Stage 2 - Authentication & Identity

Implementation authorized for Stage 2: **false**

Updated: 2026-10-07

## State

Both completed stages have been reviewed and accepted by the project owner:

| Stage                               | Status   | Accepted   | Record                                                         |
| ----------------------------------- | -------- | ---------- | -------------------------------------------------------------- |
| 0 - Engineering Foundation          | ACCEPTED | 2026-10-07 | `tasks/completed/stage-0-engineering-foundation.md`            |
| 1 - Database & Local Infrastructure | ACCEPTED | 2026-10-07 | `tasks/completed/stage-1-database-and-local-infrastructure.md` |

Stage 2 has **not** been started. No authorization has been granted, no Stage 2 task exists, and none of the
following has been done: no authentication code, no authentication dependencies, no user/account/session
models, and no Stage 2 design implementation.

## Required reading before starting any future stage

AGENTS.md, PROJECT_STATE.md, project-state.json, tasks/ROADMAP.md, the completed task records above,
docs/product/PRODUCT_SPEC.md, the architecture specifications listed in AGENTS.md,
docs/architecture/DATABASE.md, docs/architecture/MULTI_TENANCY.md, docs/architecture/SECURITY.md,
docs/security/DEPENDENCY_RISK_REGISTER.md, infrastructure/README.md, ADR-001 through ADR-007.

## Standing obligations carried across every stage

These are not tied to a stage and remain open:

1. **Two unresolved high-severity dependency advisories** (node-forge GHSA-86w9-cpqp-85rv, braces
   GHSA-vfj7-8cjw-p6xm) remain OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY. They are not
   resolved. `pnpm audit --audit-level=high` remains failing.
2. **Two scoped dependency overrides** (`'@prisma/config>deepmerge-ts': 8.0.2`, `'prisma>mysql2': 3.24.5`) sit
   ahead of Prisma's exact pins. Drop each once its parent ships an already-patched pin.
3. **`DATABASE_URL` and `REDIS_URL` are required** by the API and the worker.
4. **Hosted Linux verification is complete at `ceffd2e`.** The owner verified `validate` PASS after the Turbo repair; the separate raw audit remains FAIL as expected.
5. **Native Android/iOS device and store builds have not run.**
6. **Integration testing passed on Windows with Docker Desktop and in hosted Linux validation at `ceffd2e`.** Non-amd64 images remain unverified.
7. **The Compose PostgreSQL image is pinned to a major version** through the available pgvector tag.
8. **Redis AOF is disabled in local development.**
9. **Local Compose PostgreSQL credentials and privileges are development-only** and must never reach staging or
   production.
10. **No controlled security-audit exception mechanism exists.**
11. **`InfrastructureProbe` is temporary scaffolding.** Remove it with a new forward migration when genuine
    domain schema arrives; never rewrite accepted migration history.

Full detail for each is in the corresponding completed task record and in
`docs/security/DEPENDENCY_RISK_REGISTER.md`.

## Exact next action and handoff

Owner reviews the uncommitted closure documentation and decides whether to commit/push it. No repair verification remains pending. Stage 1 remains ACCEPTED; await explicit Stage 2 authorization.

## Post-acceptance CI repair evidence (2026-10-07)

The reported hosted `validate` failure was `Invalid environment configuration: TEST_DATABASE_URL,
TEST_REDIS_URL` in both integration suites. The separate `security-audit` failure is expected and unchanged.

Root cause: `.github/workflows/ci.yml` already declares both valid test URLs. `pnpm test:integration` first
runs the migration script outside Turbo, where the variables are available, then invokes Turbo in default
strict environment mode. Neither variable was declared in `globalEnv` or the integration task's `env`, so
Turbo removed both before Vitest. Local setup reloaded the gitignored repository `.env`, masking the defect.
Before editing, reproduction with explicit workflow URLs and `.env` temporarily hidden successfully migrated
`tsms_test`, then failed in Redis setup with the identical error (8 tests skipped; Turbo stopped on that failure).

Repair: one line in `turbo.json`, declaring `TEST_DATABASE_URL` and `TEST_REDIS_URL` in
`tasks.test:integration.env`. The workflow already provides the required explicit configuration and needs no
change. No loose environment mode, fallback to application URLs, new secrets, dependencies, application code,
schema changes, or migration edits. The accepted Stage 1 archive remains unchanged as a historical record.

Safety: PostgreSQL uses `postgresql://tsms:tsms_local_development@127.0.0.1:5432/tsms_test`; Redis uses
`redis://:tsms_local_redis@127.0.0.1:6379/1`. These are the existing throwaway Compose credentials, loopback
only, with a `_test` database and Redis DB 1. Both guards and configuration validation are unchanged.
The PostgreSQL guard checks protocol, suffix, and loopback; the existing Redis guard checks protocol and a
non-zero numeric DB index, not hostname. The explicit CI Redis URL supplies the loopback constraint.

Historical local repair validation ran on Windows / Node 24.16.0 / pnpm 12.3.4 with TSMS Docker Desktop services, workflow URLs,
`.env` temporarily hidden (restored in `finally`), and `TURBO_FORCE=true` to avoid cached results. Existing
integration suites provide the behavioral regression check; no constant-only test was added.
Results are retained in gitignored `artifacts/ci-repair-results.json` and command logs:

| Command                                                                                      | Actual result                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                             | PASS                                                                                                                                                     |
| `pnpm db:generate`                                                                           | PASS                                                                                                                                                     |
| `pnpm infra:up`                                                                              | PASS; only existing TSMS services used                                                                                                                   |
| `pnpm format:check`                                                                          | PASS                                                                                                                                                     |
| `pnpm lint`                                                                                  | PASS                                                                                                                                                     |
| `pnpm typecheck`                                                                             | PASS                                                                                                                                                     |
| `pnpm test`                                                                                  | PASS; 46 Vitest cases plus 1 Node toolchain case, including both safety guards and no application-URL fallback                                           |
| `pnpm build`                                                                                 | PASS; forced execution                                                                                                                                   |
| `pnpm check`                                                                                 | PASS; combined gate, forced execution                                                                                                                    |
| `pnpm test:integration`                                                                      | PASS after repair; migration deploy to `tsms_test` succeeded (2 migrations present, none pending), 9 PostgreSQL and 8 Redis tests executed, zero skipped |
| `pnpm smoke`                                                                                 | PASS; 16 assertions, both dependencies reachable                                                                                                         |
| `pnpm mobile:check`                                                                          | PASS                                                                                                                                                     |
| `pnpm mobile:export`                                                                         | PASS; Android bundle exported                                                                                                                            |
| `pnpm audit --audit-level=high`                                                              | FAIL, exit 1; exactly 2 high, node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm; no new advisories                                           |
| `pnpm exec prettier --write PROJECT_STATE.md project-state.json tasks/CURRENT.md turbo.json` | PASS; handoff formatting only                                                                                                                            |
| `git diff --check`                                                                           | PASS                                                                                                                                                     |

The pre-fix `pnpm test:integration` intentionally failed during reproduction as described above. An initial
PowerShell harness stopped on ordinary pnpm stderr after frozen install; its stderr handling was corrected
and the complete sequence rerun successfully (except the expected raw audit failure). Initial sandboxed
Docker inspection was denied; approved inspection succeeded. `docker compose -f infrastructure/docker-compose.yml ps`
confirmed both TSMS services healthy on loopback. They were already running before this repair and remain
running; no infrastructure reset, volume deletion, or unrelated Docker resources were used. `.env` was restored.

The Redis integration suite verified DB 1 is selected and FLUSHDB leaves its DB 0 sentinel intact. Existing
guard tests verified rejection of the application PostgreSQL database, remote PostgreSQL hosts, invalid
protocols, and Redis DB 0. Diff review confirms no new secrets, authentication code/dependencies/models,
audit configuration changes, or accepted migration edits. At the local repair handoff, the workflow clean-tree check was deferred
to hosted validation; that job has now passed at `ceffd2e`, as verified by the owner. Git status/log/diffs (including staged
diff) and `git show 635536b:.github/workflows/ci.yml` were inspected; no staged changes exist.

Action warnings (separate from the failure): the published metadata for
[actions/checkout@v4](https://raw.githubusercontent.com/actions/checkout/v4/action.yml),
[actions/setup-node@v4](https://raw.githubusercontent.com/actions/setup-node/v4/action.yml), and
[pnpm/action-setup@v4](https://raw.githubusercontent.com/pnpm/action-setup/v4/action.yml) all declare
`runs.using: node20`. GitHub now runs JavaScript actions on Node 24
([official notice](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/)).
This action runtime is separate from the project's Node 24.16.0. Action upgrades are deferred for separate
hosted validation; no action version or runtime opt-out is changed in this repair.

Runner warning: `ubuntu-latest` moves from Ubuntu 24.04 to 26.04 between October 19 and November 19, 2026
([official schedule](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/)).
Record a follow-up to validate the new image; no runner change is needed to fix environment filtering.

## State-only closure evidence (2026-10-07)

Repair commit `ceffd2e` changed `turbo.json` and the three handoff files above baseline `635536b`.
The owner verified its hosted Linux GitHub Actions results: `validate` PASS; `security-audit` FAIL - EXPECTED,
with exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. This confirms that declaring
`TEST_DATABASE_URL` and `TEST_REDIS_URL` in `tasks.test:integration.env` fixes the original hosted defect.
The owner report is the evidence source; no hosted run was independently queried during closure.
Both advisories remain unresolved and unsuppressed. The Actions runtime and Ubuntu image notices above
remain separate follow-ups, not repair failures. No repair work or hosted verification remains pending.

Repository inspection: `git status` showed a clean `main` at `ceffd2e`; `git log --oneline -10`,
`git show --stat ceffd2e`, `git show ceffd2e -- turbo.json`, and unstaged/staged diffs were inspected.
`git merge-base --is-ancestor ceffd2e HEAD` passed (exit 0); the repair is HEAD. Git emitted a
non-blocking permission warning for the global ignore file.

Only `PROJECT_STATE.md`, `project-state.json`, and `tasks/CURRENT.md` are changed for closure;
unstaged and uncommitted. No commit or push performed. No application, dependency, workflow, runner,
audit-policy, or Turbo configuration changes. Local build, integration, mobile, smoke, and audit commands
were not rerun for this documentation-only closure; earlier local results above are historical.
Native device builds remain outside this task.

Closure checks: `pnpm exec prettier --write PROJECT_STATE.md project-state.json tasks/CURRENT.md`,
`pnpm exec prettier --check PROJECT_STATE.md project-state.json tasks/CURRENT.md`, JSON parsing,
and `git diff --check` passed. Final diff review confirmed only the three state files changed.
An initial edit script stopped on a line-ending mismatch after updating only PROJECT_STATE.md;
the remaining updates were applied after normalizing line endings.

Stage 2 must not begin until the owner grants it. Do not create authentication code, install authentication
dependencies, or create user/account/session models.

DO NOT start Stage 2 without explicit owner authorization, deploy to production, suppress audit findings, broaden
the dependency overrides, introduce a security-exception framework, or rewrite accepted migration history.
