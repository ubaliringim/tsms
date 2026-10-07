# Current task: none active

There is no active implementation task.

Status: IDLE - awaiting owner authorization for the next stage

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
4. **Hosted Linux GitHub Actions has never run.** Workflows are reviewed and locally mirrored only.
5. **Native Android/iOS device and store builds have not run.**
6. **Integration testing has so far run only on Windows with Docker Desktop.**
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

Create the Stage 1 baseline commit when the owner authorizes it, then await explicit Stage 2 authorization.

Stage 2 must not begin until the owner grants it. Do not create authentication code, install authentication
dependencies, or create user/account/session models.

DO NOT start Stage 2 without explicit owner authorization, deploy to production, suppress audit findings, broaden
the dependency overrides, introduce a security-exception framework, or rewrite accepted migration history.
