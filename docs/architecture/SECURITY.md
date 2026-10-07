# Security and privacy requirements

Status: required architecture boundaries. Stage 0 is not a production security certification.

## Non-negotiable rules

Never trust client-supplied tenant identity, access tenant records without trusted context, expose cross-school data, commit credentials, publish uploaded files by default, publish generated curriculum without approval, send unnecessary student information to AI providers, bypass authorization for functionality/tests, casually use production student data in development, or deploy arbitrary agent changes to production.

Authentication proves identity; authorization checks tenant membership, permissions, and the specific resource. IDs and role names alone do not grant access. Permission examples include student.read/manage/progress.read, content.read/create/review/publish, assessment.create/publish, analytics.read, school.manage, and billing.read/manage.

## Controls by implementation stage

- Secure authentication with strong password hashing such as Argon2id, safe reset/recovery, brute-force defenses, and revocable/expiring sessions. Favor secure HttpOnly cookies for web; define mobile storage separately.
- TLS, boundary validation, appropriate CORS/CSRF/security headers, rate/payload limits, request IDs, and non-sensitive error responses.
- Tenant-aware queries, constraints, object-level authorization, security tests, and evaluated database defense in depth.
- Authenticated and authorized uploads with size/actual-type checks, security scanning, private storage, and temporary signed URLs. File extension alone is insufficient.
- Secrets in controlled environment/secret management, never source/logs/client bundles. Browser/mobile public environment variables are not secret storage.
- Audit sensitive actions, including USER_CREATED, ROLE_CHANGED, STUDENT_IMPORTED, CONTENT_PUBLISHED, ASSESSMENT_PUBLISHED, RESULT_CHANGED, RESOURCE_DELETED, TENANT_SETTING_CHANGED, and SUPPORT_ACCESS_GRANTED. Record actor, action, resource, tenant, and time with minimized metadata.
- Structured sanitized logs, dependency scanning, operational monitoring, backups, restore verification, and incident/recovery procedures.

## Children's privacy

Collect only necessary data; do not gather precise location speculatively. Limit profile/leaderboard visibility and allow school policy to govern it. Define guardian involvement, account management, exports, retention/deletion, and communications before launch.

Platform operations and access to children's learning content are separate privileges. Future support access requires justification, scope, limited duration where possible, and audit. Keep environments separate and use synthetic data.

AI payloads contain only required curriculum/learning context. Uploaded documents are untrusted and cannot override system policy. Generated content needs validation, grounding, and approval. Logs must not become a second store of private profiles, prompts, answers, or tokens.

Appropriate legal/privacy review is required before commercial launch, including applicable Nigerian obligations. This document does not assert legal compliance or invent legal conclusions.

## Stage 0 limits

Only process liveness endpoints exist. There is no authentication, database, tenant data, file upload, or production deployment. Local development endpoints default to loopback. Dependency review is part of validation; environment examples are deliberately non-secret. Future security work is not represented as complete.

## Stage 1 infrastructure security boundaries

Stage 1 adds PostgreSQL, Redis, and Prisma. It adds no authentication, no tenant data, and no product functionality.

- **Configuration is validated before listening.** `DATABASE_URL` and `REDIS_URL` are required and are checked for
  URL shape and for the correct protocol. A missing or malformed value fails startup with a non-zero exit code.
  Validation errors name **keys only** and never echo a supplied value, because these variables carry credentials.
- **Infrastructure is development-only.** Every credential in `infrastructure/docker-compose.yml` is a throwaway
  local value, and published ports are bound to loopback. `.env.example` documents them as such. No production
  secret exists in the repository.
- **Readiness discloses no internals.** `/ready` reports only whether each dependency is `up` or `down`. Driver
  error text, connection strings, hostnames, and passwords are never returned, and readiness never logs them.
  Database and Redis client logging is off by default for the same reason.
- **Liveness cannot be used to leak dependency state.** `/health` never contacts a dependency.
- **Destructive test work is guarded in code, not by convention.** Integration tests refuse to open a connection
  unless the database name ends in `_test` and the host is loopback, and unless the Redis URL selects a non-zero
  logical database. `pnpm db:test:migrate` applies the same guard, so it cannot be pointed at application data.
  Rejection messages never include the URL.
- **Prisma query logging is off by default**, so a failure cannot write connection details to stdout.
- **`CREATE EXTENSION` privileges are called out.** Local Compose uses a superuser role; staging and production
  migration roles need the privilege explicitly, and the pgvector migration documents that.

Still absent and still required before launch: authentication, authorization, tenant isolation, audit logging,
secret management, TLS termination, rate and payload limits, backups, and restore verification. Stage 1 does not
move any of these closer to done.
