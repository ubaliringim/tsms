# Accepted task: Stage 1 - Database & Local Infrastructure

Task: 1.1 - Database and local infrastructure foundation

Status: ACCEPTED (owner decision, 2026-10-07)

Accepted by: Project owner

Acceptance date: 2026-10-07

Stage: 1 - Database & Local Infrastructure

Implementation authorized: yes (owner, 2026-10-07) - work complete

Stage 0: ACCEPTED (owner decision, 2026-10-07). Record preserved at `tasks/completed/stage-0-engineering-foundation.md`.

Next planned stage after this one: Stage 2 - Authentication & Identity. **Not authorized.**

Updated: 2026-10-07 (implemented, closure-validated, and accepted on 2026-10-07)

## Required reading

AGENTS.md, PROJECT_STATE.md, docs/product/PRODUCT_SPEC.md, the architecture specifications listed in AGENTS.md,
docs/architecture/DATABASE.md, docs/architecture/MULTI_TENANCY.md, docs/security/DEPENDENCY_RISK_REGISTER.md,
infrastructure/README.md, ADR-001 through ADR-007, and tasks/ROADMAP.md.

## Goal and scope

Establish the production-oriented persistence and local infrastructure foundation: PostgreSQL, Redis, Prisma,
reproducible local infrastructure, validated infrastructure configuration, connectivity, migrations,
health/readiness checks, and infrastructure testing.

## Out of scope

No users, memberships, roles, permissions, tenants, schools, students, teachers, academic sessions, terms,
classes, subjects, enrollments, curricula, topics, concepts, resources, learning objects, assessments, mastery,
recommendations, XP, achievements, subscriptions, or billing. No authentication, RBAC, tenant middleware or query
filters, Row-Level Security, object storage, BullMQ queues, AI, RAG, or production deployment.

The single Prisma model, `InfrastructureProbe`, is an infrastructure probe with no business meaning. It exists to
prove the migration and query lifecycle and is scheduled for replacement when the first domain model lands.

## Acceptance checklist

- [x] PostgreSQL local service starts reproducibly from a pinned image.
- [x] Redis local service starts reproducibly from a pinned image.
- [x] Named volumes configured; data survives container restart and recreation.
- [x] `DATABASE_URL` and `REDIS_URL` validated, required, and non-echoing on failure.
- [x] Prisma configured in `packages/database` as the canonical database package.
- [x] Prisma client generation succeeds and is compiled to `dist`.
- [x] Migration workflow succeeds; migration files are committed.
- [x] A fresh database reaches the expected migration state via `migrate deploy`, idempotently.
- [x] API connects to PostgreSQL and to Redis.
- [x] API liveness is independent of dependency readiness.
- [x] API readiness correctly reports PostgreSQL and Redis state, without leaking details.
- [x] Worker has an equivalent readiness mechanism.
- [x] Database integration tests pass against real PostgreSQL.
- [x] Redis integration tests pass against real Redis.
- [x] Dependency-unavailable behaviour tested with infrastructure stopped.
- [x] Test-database safety enforced in code, not by convention.
- [x] Root formatting, lint, typecheck, unit tests, and build pass.
- [x] Integration test command separated from the Docker-free unit test command.
- [x] Existing Stage 0 smoke behaviour still passes.
- [x] `git diff --check` succeeds.
- [x] No credentials or secrets committed.
- [x] Stage 0 accepted dependency-risk records intact and extended, not weakened.
- [x] No Stage 2+ business functionality implemented.
- [x] Stage 1 reviewed and accepted by owner (2026-10-07).

## Validation commands

Unit tests need no Docker. Everything else needs the Docker Compose services.

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm mobile:check
pnpm smoke
pnpm audit --audit-level=high
pnpm infra:up
pnpm test:integration
git diff --check
```

## Completed implementation

- Created `infrastructure/docker-compose.yml`: pinned `pgvector/pgvector:0.8.7-pg17` (PostgreSQL 17.11 with
  pgvector 0.8.7) and `redis:8.8.3-alpine`, both on loopback ports, both with healthchecks, both with named volumes.
  A one-shot `postgres-test-init` container idempotently creates the `tsms_test` database.
- Created `packages/database`: `prisma.config.ts`, `prisma/schema.prisma`, two committed migrations, the
  `src/generated/prisma` client output (gitignored), a client factory with explicit lifecycle, and a test-database
  safety guard.
- Created `packages/redis`: a minimal client factory with explicit lifecycle, readiness-bounded ping, shutdown,
  and a test-Redis safety guard.
- Extended `packages/config`: `DATABASE_URL` and `REDIS_URL` are now required and protocol-checked, plus a
  dedicated `parseIntegrationEnvironment` that requires `NODE_ENV=test` and separate `TEST_*` variables.
- Split API and worker infrastructure into thin NestJS/plain adapters. No Prisma setup lives in an application.
- Added `/ready` to both the API and the worker. `/health` is unchanged and never touches a dependency.
- Added a real migration lifecycle: `db:generate`, `db:migrate`, `db:deploy`, `db:status`, `db:reset`,
  `db:studio`, `db:test:migrate`.
- Enabled pgvector through a reviewed migration so the capability reproduces in staging and production.
- Extended `scripts/smoke.mjs` with missing/malformed infrastructure URL cases and readiness assertions that hold
  both with infrastructure up and with it down.
- Rewrote `docs/architecture/DATABASE.md`, `infrastructure/README.md`, and extended `SECURITY.md`,
  `MULTI_TENANCY.md`, `ARCHITECTURE.md`, and `docs/security/DEPENDENCY_RISK_REGISTER.md`.

## Deliberate decisions

**pgvector is enabled now.** The image is the same size class as plain PostgreSQL, so enabling it costs nothing and
removes a future foundation change. Stage 1 creates no vector columns, indexes, embeddings, or retrieval code.
Availability is all that is established, through a committed migration rather than a Docker-only init script.

**Redis is a separate package from database.** They have different lifecycles and different consumers. Keeping
them apart avoids a package that owns two unrelated things.

**BullMQ is deferred.** No stage has a job to run. A BullMQ worker also needs `maxRetriesPerRequest: null`, which
the Stage 1 client deliberately does not set. Adding it now would be unused complexity.

**Object storage is deferred** to the resources/content stage, where uploads actually arrive.

**No external connection pooler.** Prisma 7 delegates pooling to `pg` through the adapter. The production pooling
strategy depends on the deployment target and interacts with the RLS investigation; it belongs to a later stage.

**One Prisma client per process.** Shared-schema multi-tenancy means the client is stateless with respect to
tenants, so a per-request or per-tenant client would be wrong as well as wasteful.

## Remediation of new advisories

Adding Prisma introduced three advisories that were not in the Stage 0 baseline. All three had patched upstream
releases, so all three were remediated rather than accepted, and the Stage 0 owner acceptance was not relied on.

| Advisory            | Package      | Was    | Now    | Fix             |
| ------------------- | ------------ | ------ | ------ | --------------- |
| GHSA-ggr8-5vv4-36mx | deepmerge-ts | 7.1.5  | 8.0.2  | scoped override |
| GHSA-3f6p-5ww8-9rcr | mysql2       | 3.15.3 | 3.24.5 | scoped override |
| GHSA-rgwj-5xj2-c3m3 | mysql2       | 3.15.3 | 3.24.5 | scoped override |

Compatibility analysis for the `deepmerge-ts` major bump, residual risk, and review triggers are in
`docs/security/DEPENDENCY_RISK_REGISTER.md`. `pnpm audit --audit-level=high` returns to exactly the Stage 0
baseline afterwards.

## Validation evidence

Executed on Windows with Node 24.16.0 / pnpm 12.3.4, Docker 29.6.1, Compose v5.3.0. Turbo cache hits reused
earlier successful local executions where inputs were unchanged.

| Command/check                         | Result  | Notes                                                                                                                  |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`      | PASS    | Lockfile accepted with no resolution changes.                                                                          |
| `pnpm format` / `pnpm format:check`   | PASS    | All matched files use Prettier formatting.                                                                             |
| `pnpm lint`                           | PASS    | No errors or warnings under max-warnings=0. Generated Prisma client is ignored.                                        |
| `pnpm typecheck`                      | PASS    | 11 Turbo tasks across 9 workspaces.                                                                                    |
| `pnpm test`                           | PASS    | 46 Vitest cases plus 1 Node toolchain test. **No Docker required.**                                                    |
| `pnpm build`                          | PASS    | 7 targets including the new packages.                                                                                  |
| `pnpm check`                          | PASS    | format, lint, typecheck, test, build all succeeded.                                                                    |
| `pnpm mobile:check`                   | PASS    | Re-run at closure: "Dependencies are up to date". No mobile regression.                                                |
| `pnpm mobile:export`                  | PASS    | Re-run at closure: 578 modules, bundle hash identical to Stage 0. No vulnerable code in the artifact.                  |
| `pnpm smoke`                          | PASS    | 16 assertions, including fail-fast on missing/malformed URLs and readiness.                                            |
| `pnpm smoke` (infrastructure stopped) | PASS    | Liveness 200 with dependencies down; readiness 503 naming both, no leakage.                                            |
| `pnpm infra:up`                       | PASS    | Both containers healthy; `tsms_test` created.                                                                          |
| `pnpm test:integration`               | PASS    | 9 database + 8 Redis integration cases against live services.                                                          |
| `pnpm db:test:migrate`                | PASS    | `migrate deploy` against `tsms_test`.                                                                                  |
| `prisma validate`                     | PASS    | Schema valid.                                                                                                          |
| `prisma generate`                     | PASS    | Client generated; package compiles it to `dist`.                                                                       |
| `prisma migrate status`               | PASS    | Up to date.                                                                                                            |
| Fresh database to expected state      | PASS    | Created `tsms_fresh_check` from scratch, `migrate deploy` applied both migrations, second run was a no-op. Cleaned up. |
| Volume persistence                    | PASS    | Wrote a row, restarted the containers, row survived. Cleaned up.                                                       |
| pgvector availability                 | PASS    | `vector 0.8.7` present in both `tsms` and `tsms_test`; zero `vector`-typed columns.                                    |
| `pnpm audit --audit-level=high`       | FAIL    | 2 high findings: node-forge and braces, both `Patched versions: None`, both owner-accepted. No new advisories.         |
| `git diff --check`                    | PASS    | No whitespace errors.                                                                                                  |
| Hosted GitHub Actions                 | NOT RUN | No remote/push performed.                                                                                              |

### Bugs found and fixed during implementation

- The ioredis client was created with `lazyConnect: true` together with `enableOfflineQueue: false`. That
  combination makes every command fail before the socket is ready. Replaced with an eager connect plus a
  bounded `pingRedis` timeout so readiness reports a down dependency instead of hanging.
- Zod 4 runs refinement checks even after an earlier check has failed, so `new URL(value)` inside `.refine()`
  threw instead of producing a validation issue. Wrapped parsing defensively so a malformed URL reports a
  `DATABASE_URL` / `REDIS_URL` issue.
- The test-database guard initially echoed the rejected hostname. Removed, so guard messages never contain any
  part of the supplied URL.
- The `docker-compose` test-database init container connected over a local socket that does not exist in a
  separate container. Changed to TCP, and passed the password via `PGPASSWORD`.
- Two of my own tests were wrong rather than the code: a `not.toContain('')` assertion that can never hold, and
  an un-awaited promise in the API route test. Both fixed.
- A leftover draft `database.module.ts` imported `PrismaClient` as a type-only import and was superseded by
  `infrastructure/`. Deleted.

## Meaningful tests

Total: 47 tests, of which 17 require Docker.

- 21 environment cases: safe host defaults; missing `DATABASE_URL` / `REDIS_URL` for both API and worker;
  malformed and wrong-protocol URLs for each key with no value echoed; port range; invalid mode and host; unknown
  keys stripped; integration environment requiring `NODE_ENV=test` and refusing to fall back to application URLs.
- 8 database safety cases: accepts a loopback `*_test` database; rejects a database without the suffix, one that
  merely contains `test`, one with no name, a remote host, a non-PostgreSQL URL, unparseable input; never echoes
  the URL.
- 4 Redis safety cases: accepts a non-zero logical database; rejects database `0`, an explicit `/0`, a non-numeric
  path, a non-Redis URL, and unparseable input; never echoes the URL.
- 9 database integration cases against real PostgreSQL: raw query, exact applied migration list, no failed
  migration, pgvector present with zero vector columns, typed create/read/delete round trip, unique constraint
  enforcement, `$transaction` commit and rollback, double-close tolerated, unreachable port fails.
- 8 Redis integration cases against real Redis: lazy connect and PING, value round trip, logical index matches the
  guard, bounded ping, TTL, FLUSHDB scoped so database `0` is untouched, double-close tolerated, unreachable port
  fails.
- 9 API cases: liveness independent of dependencies, readiness 503 with a well-formed body, no credential or
  connection-string leakage, unimplemented product route still 404, plus controller-level ready/not-ready shapes.
- 4 worker cases: liveness with infrastructure down, readiness 503 shape, no leakage, unsupported paths and
  methods still 404.
- 1 Expo - config-plugins - xcode integration case (carried from Stage 0).

## Files and repository structure

Two new workspaces: `packages/database` and `packages/redis`, alongside the Stage 0 `packages/config`. New
top-level items: `infrastructure/docker-compose.yml`, `packages/database/prisma/**` (schema plus two migrations),
`packages/database/scripts/migrate-test.mjs`, and the Stage 1 task record under `tasks/completed/`.

`packages/database/src/generated/` is generated Prisma output and is gitignored; regenerate with `pnpm db:generate`.
`dist/` build outputs and `.env` remain ignored. The repository `.env` used for local verification is gitignored and
contains only local Docker Compose credentials.

## Known issues and deviations

1. **The dependency audit still fails.** `pnpm audit --audit-level=high` exits 1 on node-forge 1.4.0
   (GHSA-86w9-cpqp-85rv) and braces 3.0.3 (GHSA-vfj7-8cjw-p6xm). Neither has a patched upstream release; both
   remain installed and unresolved under the owner's accepted temporary dispositions. No new advisory remains.
2. **Two overrides now sit ahead of Prisma's exact pins.** `deepmerge-ts: 8.0.2` and `mysql2: 3.24.5` remediate
   real advisories, but if a future Prisma release depends on 7.x/3.15.x behaviour the override could mask it.
   Drop the overrides as soon as Prisma ships already-patched versions.
3. **The API and worker now require `DATABASE_URL` and `REDIS_URL`.** This is a deliberate contract change from
   Stage 0, where they were absent. Any existing deployment, script, or CI job that starts these services without
   those variables will now fail fast. `.env.example` and `infrastructure/README.md` document them.
4. **`scripts/smoke.mjs` was rewritten.** The Stage 0 timing fragility is fixed: the fail-fast deadline moved
   from 10s to 30s, and readiness assertions were added. This is a change to Stage 0 tooling made deliberately in
   Stage 1 because the script had to change anyway; it was not an unrelated edit.
5. **CLOSED at closure: mobile was validated, not skipped.** `pnpm mobile:check` and `pnpm mobile:export` both pass; the exported bundle hash is identical to Stage 0 and contains no vulnerable code. No longer an open limitation.
6. **Hosted Linux GitHub Actions has not run.** No remote or push was performed.
7. **Native Android/iOS device and store builds have not run.** Stage 1 does not touch native.
8. **Integration tests were verified on Windows with Docker Desktop only.** Linux-container behaviour, Apple
   Silicon images, and multi-architecture pulls were not exercised.
9. **`docker-compose.yml` pins a Postgres major, not a minor.** `pgvector/pgvector:0.8.7-pg17` pins the pgvector
   release and the PostgreSQL major; the resolved minor is whatever that tag ships (17.11 at review time).
   Rebuilding with a new `pg17` image would change the minor without a code change. Not reproducible at minor
   granularity because no such tag exists.
10. **Redis append-only persistence is disabled** (`--appendonly no`, `--save ''`). Local cache/queue state is
    disposable and this keeps reset fast. If a later stage needs Redis durability, that decision must be revisited
    together with the volume strategy.
11. **`tsms` is a PostgreSQL superuser in the local compose file.** Convenient for shadow databases and
    `CREATE EXTENSION`. This is development-only and must never be mirrored to staging or production.

## Security and working tree

No credentials were committed. `.env.example` contains only local Docker Compose values, documented as
development-only. `.env` is gitignored. No third-party source was modified, no fork or patched package was
introduced, no advisory was suppressed, and the audit threshold was not lowered. Readiness responses and
validation errors were tested for absence of passwords, connection strings, hostnames, and driver error text.

`git log` shows only the Stage 0 baseline commit `ebb3111`. All Stage 1 work is uncommitted and reviewable through
`git diff` and the new untracked files.

## Closure validation (2026-10-07)

A closure pass was run before owner review. It changed no product behaviour and added no domain functionality.
It found **two real Stage 1 defects**, both now fixed and re-verified.

### Defect 1 - a fresh checkout could not build (FIXED)

`packages/database` compiles the generated Prisma Client, but generation was only wired to a manual
`pnpm db:generate`. `packages/database/src/generated` is gitignored, so a clean clone had no client and the
build failed:

```
src/client.ts(2,29): error TS2307: Cannot find module './generated/prisma/client.js'
src/client.ts(3,30): error TS2307: Cannot find module './generated/prisma/client.js'
```

`pnpm check` returned exit 1 from a clean state. This would have broken CI and every fresh local clone.

Fix: `packages/database` now runs `prisma generate` as part of its own `build` and `typecheck` scripts, so the
requirement is local to the package that has it and no shared Turborepo configuration had to change. Turborepo
Package Configurations were deliberately not used because they are marked experimental in the installed docs.
Verified with forced no-cache execution: `turbo run build --force`, `turbo run typecheck --force`, and
`turbo run test --force` all pass with `src/generated` absent. `prisma generate` also verified working with no
`DATABASE_URL` and no `.env`, which is the CI condition.

### Defect 2 - `pnpm infra:up` returned a non-zero exit code (FIXED)

The one-shot `postgres-test-init` compose service exits after creating `tsms_test`. `docker compose up --wait`
treats a service that exits as a failure, so the documented start command returned **exit 1** even though both
services were healthy. Reproduced deterministically (two runs, both exit 1); isolating by starting only
`postgres redis` returned exit 0, confirming the init service was the cause. This would have failed CI.

Fix: the init service was removed. It was also redundant - `prisma migrate deploy` creates its target database
when absent, and `pnpm db:test:migrate` already calls exactly that against the guarded `TEST_DATABASE_URL`.
Verified end to end: `pnpm infra:reset` then `pnpm infra:up` (exit 0, both healthy) then `pnpm test:integration`
created `tsms_test`, applied both migrations, and passed. `pnpm infra:up` now exits 0 deterministically.

### Mobile regression validation

Stage 1 changed the dependency graph, lockfile, workspace config, overrides, Turbo config, and env config, so
mobile was re-validated rather than assumed unaffected. `pnpm mobile:check` PASS ("Dependencies are up to date").
`pnpm mobile:export` PASS, producing bundle `index-500e2c2dfc1958da03c9be03aa4cb42b` - the **same content hash as
Stage 0**, so no mobile regression. The exported Hermes bundle was re-scanned: no node-forge, braces, micromatch,
`pki.rsa`, `fillRange`, or `EXPAND_RANGE`.

### CI readiness

The Stage 0 workflow was **not** sufficient for Stage 1. `.github/workflows/ci.yml` was updated minimally:

| Problem in the Stage 0 workflow                                                           | Fix                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No `DATABASE_URL` / `REDIS_URL`, so `pnpm smoke` could not start the API or worker at all | Disposable endpoints set as workflow-level `env`                                           |
| No Prisma Client generation step, so `pnpm check` failed on the clean runner              | `pnpm db:generate` before `pnpm check`                                                     |
| No PostgreSQL/Redis for the integration tests                                             | `pnpm infra:up` (Compose, not job `services:`) so CI validates the real developer workflow |
| Integration tests never executed                                                          | `pnpm test:integration` as an explicit step                                                |
| Services left running after a failed step                                                 | `if: always()` teardown                                                                    |
| Audit failure was indistinguishable from a functional regression                          | Audit moved to a dedicated `security-audit` job                                            |

Unit tests remain Docker-independent by design, and integration tests execute explicitly. CI uses the documented
throwaway local values so it exercises the same real credentials a developer uses; there is no secret store
reference and no production credential.

**The known raw audit failure will keep the workflow red.** `pnpm audit --audit-level=high` exits 1 because of the
two owner-accepted advisories, so the `security-audit` job fails on every run until upstream ships a patch. The
workflow overall therefore reports red. This is a distinction, not a suppression: the command is unchanged, there
is no `continue-on-error`, no `|| true`, no advisory ignore list, no threshold change, and no severity downgrade.
Verified by parsing the workflow YAML: two jobs, exactly one audit step, `continue-on-error` absent. The reason
for the split is recorded in `docs/security/DEPENDENCY_RISK_REGISTER.md`.

### Override scope narrowing and remediation proof

Both Stage 1 overrides were **global** at implementation and are now scoped to their introducing parent:
`'@prisma/config>deepmerge-ts': 8.0.2` and `'prisma>mysql2': 3.24.5`. Each package reaches the graph only through
that one Prisma parent, so the effect is identical today while a future unrelated consumer is no longer silently
upgraded. Resolution, `pnpm why`, the Prisma CLI, the full suite, integration tests, mobile validation, and the
audit were re-verified after narrowing.

Remediation was proven three independent ways rather than asserted: `pnpm why -r` shows one version each; the
lockfile contains no reference to `deepmerge-ts@7.1.5` or `mysql2@3.15.3`; and a symlink walk of every workspace
`node_modules` found **zero** references to the pre-override directories. Two orphaned copies left on disk by an
earlier install were unlinked from no workspace and were removed, then install and audit were re-verified.

### InfrastructureProbe review

Confirmed no tenant or business semantics (columns are `id`, a unique `label`, `createdAt`); documented as
infrastructure scaffolding in the schema, in `DATABASE.md`, and in `packages/database/src/client.ts`; referenced
only by `schema.prisma` and `packages/database/tests/database.integration.test.mjs`, with **no** reference from
`apps/api`, `apps/worker`, `packages/config`, or `scripts`. Replacement on first domain model is documented.
Migration-history immutability after Stage 1 acceptance is now stated explicitly in `DATABASE.md`. The model was
kept because it is serving the migration and integration-test lifecycle correctly.

### Smoke-script review

The diff was reviewed in full. Stage 0 liveness assertions are retained unchanged, including the deep-equal body
assertions for `/health` and the web/Control production-route checks. Stage 1 added eight fail-fast assertions for
missing and malformed infrastructure URLs plus readiness assertions that branch on whether dependencies are up.
No old assertion was weakened. The raised deadline cannot hide a persistent failure: the assertion is still
`exitCode === 1`, so a process that never exits fails the test rather than passing it. The 60-second liveness
`waitFor` timeout is unchanged; only the fail-fast deadline moved from 10s to 30s, which is the Stage 0 timing
issue. Process cleanup is unchanged: the `finally` block still terminates every tracked child, and it now covers
more children because the eight new fail-fast checks also register theirs.

One improvement was made: the script now reads `DATABASE_URL` and `REDIS_URL` from the environment with the local
values as fallback, and derives its leak assertions from those values, instead of hardcoding them. This lets CI
exercise the ready path with its own credentials and removes hardcoded passwords from a script.

### Docker Compose review

`docker compose -f infrastructure/docker-compose.yml config` parses cleanly. Verified from the resolved config:
both published ports are bound to `127.0.0.1` only (`postgres` 5432, `redis` 6379) with no non-loopback binding;
named volumes `tsms-postgres-data` and `tsms-redis-data` persist; healthchecks are `pg_isready -U tsms -d tsms` and
an authenticated `redis-cli ping`; there is no `prune` or `--force` anywhere in the file, so no destructive
operation is automatic; restart policies are `unless-stopped` for the two services; and the Redis
`REDIS_PASSWORD` matches the password in `REDIS_URL` in `.env.example`.

### Fresh-state reproducibility

Deliberately scoped: only TSMS-owned resources were manipulated, with no `docker system prune` and no broad
cleanup. Pre-check confirmed exactly 2 TSMS-owned volumes out of 20 on the host. `pnpm infra:reset` removed exactly
those 2 and left the other 18 untouched. Then the exact CI sequence was run from the destroyed state:
`pnpm infra:up` exit 0, PostgreSQL healthy, Redis healthy, `tsms_test` absent beforehand, and
`pnpm test:integration` exit 0 after creating `tsms_test`, applying both migrations, and passing. Post-conditions
confirmed: both migrations recorded as finished, `vector 0.8.7` present, `infrastructure_probes` created, and zero
leftover probe rows.

### Closure changes summary

| File                                                                         | Change                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`                                                   | Rewritten for Stage 1: infrastructure env, `db:generate`, `infra:up`, explicit `test:integration`, teardown, audit split into its own job. |
| `packages/database/package.json`                                             | `build` and `typecheck` now run `prisma generate` first.                                                                                   |
| `pnpm-workspace.yaml`                                                        | Both overrides narrowed to parent-scoped form, with removal and re-evaluation triggers documented.                                         |
| `infrastructure/docker-compose.yml`                                          | Removed the `postgres-test-init` service, with the reason recorded inline.                                                                 |
| `infrastructure/README.md`                                                   | Init-service references removed; test database now documented as created on demand.                                                        |
| `docs/architecture/DATABASE.md`                                              | Closure correction for the init service; InfrastructureProbe review result and migration-immutability rule.                                |
| `docs/security/DEPENDENCY_RISK_REGISTER.md`                                  | Narrowed override table, exact chains, three-way remediation proof, override removal triggers, CI audit-gate rationale.                    |
| `scripts/smoke.mjs`                                                          | Reads infrastructure URLs from the environment and derives leak assertions from them.                                                      |
| `packages/database/prisma/schema.prisma`                                     | `prisma format` applied (column alignment and trailing newline). Semantics unchanged.                                                      |
| `PROJECT_STATE.md`, `project-state.json`, `tasks/CURRENT.md`, `CHANGELOG.md` | Closure findings recorded.                                                                                                                 |

No product or domain functionality was added. Stage 1 was not redesigned.

---

## Acceptance

The project owner reviewed the Stage 1 implementation and the Stage 1 Closure Validation report and accepted
Stage 1 on **2026-10-07**. The accepted scope is: PostgreSQL local infrastructure, Redis local infrastructure, the
pgvector extension foundation, the Prisma 7 database foundation, `packages/database`, `packages/redis`, the
migration workflow, database and Redis lifecycle handling, API/worker liveness and readiness, integration-test
infrastructure, test-database safety controls, the Docker Compose workflow, fresh-state reproducibility, the
Stage 1 CI workflow changes, the Prisma dependency security remediations, the temporary `InfrastructureProbe`,
and the smoke-test readiness extensions.

The Stage 1 known issues were reviewed and accepted as **non-blocking for Stage 1**. They remain open and are
carried forward as known issues, not as completed work.

### Acceptance does not change any security disposition

- The two Stage 0 advisories (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm) remain
  **OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY**. They are **not** resolved and **not**
  remediated. Both packages remain installed.
- `pnpm audit --audit-level=high` remains **failing**. Accepting Stage 1 does not change that.
- The three Stage 1 advisories (deepmerge-ts, mysql2 twice) remain recorded as remediated. That record was
  re-confirmed at acceptance: `pnpm why -r` resolves `deepmerge-ts@8.0.2` and `mysql2@3.24.5` only,
  `pnpm-lock.yaml` contains no reference to the pre-override versions, and the virtual store contains no copy
  of them.

## Carried-forward known issues

These remain open after Stage 1 acceptance. None is represented as complete.

1. **Raw audit still fails** on the two unresolved Stage 0 advisories. The CI workflow reports red because of it.
2. **Two scoped overrides remain ahead of Prisma's upstream exact pins** - `'@prisma/config>deepmerge-ts': 8.0.2`
   and `'prisma>mysql2': 3.24.5`. Remove each once its parent ships an already-patched pin. Revisit on any Prisma
   upgrade or downgrade.
3. **`DATABASE_URL` and `REDIS_URL` are now required** infrastructure configuration. Any script, service, or CI
   job that omits them fails fast.
4. **Hosted Linux GitHub Actions has not run** against the Stage 1 commit. The workflow is reviewed and locally
   mirrored only.
5. **Native Android/iOS device and store builds have not run.**
6. **Integration testing has so far been performed on Windows with Docker Desktop.** Linux-container behaviour and
   non-amd64 images were not exercised.
7. **The Compose PostgreSQL image is pinned to the PostgreSQL major** through the available
   `pgvector/pgvector:0.8.7-pg17` tag rather than to a patch release, because no finer pgvector tag exists.
8. **Redis AOF is disabled in local development.** Revisit with any stage that needs Redis durability.
9. **Local Compose PostgreSQL credentials and privileges are development-only** and must never be copied to
   staging or production.
10. **No controlled security-audit exception mechanism exists yet.** Reviewed temporary exceptions cannot be
    machine-distinguished from new findings. Deferred to a future security-policy task.
11. **`InfrastructureProbe` is temporary infrastructure scaffolding.** It should be replaced or removed
    appropriately when genuine domain schema arrives. Accepted migration history must not be rewritten: remove
    the probe with a new forward migration, never by editing an applied migration.

---

## Exact next action and handoff

Stage 1 was accepted by the project owner on 2026-10-07. This record is now the durable Stage 1 handoff.

The next step is to create the Stage 1 baseline commit once authorized. Stage 2 - Authentication & Identity is the
next planned stage, but **no implementation authorization has been granted and no Stage 2 task is active.** No
authentication code, dependencies, or models exist.

Standing obligations carry forward: track the two unresolved Stage 0 advisories; revisit the two scoped
overrides on the next Prisma upgrade; re-run this stage's validation if any review trigger in
`docs/security/DEPENDENCY_RISK_REGISTER.md` fires; and do not rewrite accepted migration history.

Standing obligations: track the two unresolved dependency advisories; revisit the two overrides on the next Prisma
upgrade; re-run the analysis if any review trigger in `docs/security/DEPENDENCY_RISK_REGISTER.md` fires.

DO NOT start Stage 2, implement product or domain functionality, suppress audit findings, mark the accepted
advisories resolved, weaken tenant/approval/authorization rules, run `pnpm db:reset` or `pnpm infra:reset` against
anything but local development, or deploy to production.
