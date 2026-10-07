# Changelog

## Unreleased

### Stage 1 - Database & Local Infrastructure (accepted 2026-10-07)

- Added reproducible local PostgreSQL 17.11 (with pgvector 0.8.7) and Redis 8.8.3 infrastructure on loopback, with named volumes and healthchecks.
- Added `@tsms/database`: Prisma 7 schema, committed migrations, compiled client factory with explicit lifecycle, and a test-database safety guard.
- Added `@tsms/redis`: ioredis client factory with explicit lifecycle, readiness-bounded ping, shutdown, and a test-Redis safety guard.
- Required and validated `DATABASE_URL` and `REDIS_URL`; added a test-only environment that cannot fall back to application URLs.
- Separated process liveness (`/health`) from dependency readiness (`/ready`) in the API and the worker.
- Established a real migration lifecycle, with `migrate deploy` for staging/production and pgvector enabled through reviewed migration SQL.
- Added 47 unit tests that need no Docker and 17 integration tests that do, plus readiness and fail-fast smoke coverage.
- Remediated three advisories introduced by Prisma (`deepmerge-ts`, `mysql2` x2) with overrides scoped to the introducing Prisma parent.
- Closure validation: fixed a fresh-checkout build failure (Prisma Client generation is now part of the database package build) and a non-zero `pnpm infra:up` exit code (removed the redundant one-shot test-database container).
- Updated CI for Stage 1: infrastructure endpoints, Prisma generation, Compose services, explicit integration tests, and the raw audit isolated in its own job that still fails on the two accepted advisories.
- Re-validated mobile: dependency check and Android export both pass with an unchanged bundle hash.
- Stage 1 accepted by the owner on 2026-10-07. Its known issues were reviewed and accepted as non-blocking and remain open.
- No TSMS domain model, authentication, tenancy, queues, object storage, or production deployment. Stage 2 (Authentication & Identity) is the next planned stage and is not authorized.

### Stage 0 - Engineering Foundation (accepted 2026-10-07)

- Organized TSMS specifications, seven accepted ADRs, roadmap, and agent handoff protocol.
- Established a pnpm/Turborepo TypeScript workspace and five minimal application foundations.
- Added shared server configuration, process-liveness checks, meaningful foundation tests, and validation/CI baseline.
- Completed reachability analysis for two open high-severity dependency advisories and recorded them in `docs/security/DEPENDENCY_RISK_REGISTER.md`.
- Owner accepted temporary dispositions for `node-forge` (GHSA-86w9-cpqp-85rv) and `braces` (GHSA-vfj7-8cjw-p6xm) on documented non-reachability. Both remain installed and unresolved; no advisory was suppressed and the audit gate still fails.
- No product features, data services, or production deployment.
