# Database and domain model direction

Status: Stage 1 database machinery is accepted. Stage 2.1 adds global identity persistence only; see the Stage 2.1 section below. All other domain groups remain conceptual.

## Sources of truth

PostgreSQL owns structured business truth. Object storage owns files. Learning events are activity evidence; mastery and analytics are derived state; embeddings are retrieval indexes. AI output never becomes authoritative identity, billing, security, or curriculum approval state by itself.

## Domain groups to introduce incrementally

| Area                 | Eventual records                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/tenancy     | users, tenants, schools, memberships, roles, permissions, membership_roles, role_permissions, student_profiles, teacher_profiles      |
| Academics            | academic_sessions, academic_terms, academic_levels, class_groups, student_enrollments, subjects, class_subjects, teacher_assignments  |
| Curriculum           | curricula, curriculum_units, topics, concepts, concept_relationships                                                                  |
| Resources/content    | resources, resource_chunks, resource_concepts, learning_objects, learning_object_sources, ai_generations, content_reviews             |
| Assessment           | questions, question_options, assessments, assessment_questions, assessment_attempts, assessment_answers                               |
| Learning             | learning_sessions, learning_session_items, practice_attempts, student_concept_mastery, mastery_updates, assignments                   |
| Engagement/reporting | xp_transactions, student_streaks, achievement_definitions, student_achievements, learning_events, analytics aggregates, notifications |
| Operations           | tenant_branding, tenant_domains, tenant_features, plans, subscriptions, usage counters, audit_logs                                    |

Only global users and their authentication persistence primitives arrive in Stage 2.1. Other records arrive with their own approved stage, migration, and isolation tests.

## Invariants

- Separate global identity from tenant membership; student/teacher profiles attach to membership context.
- School-owned records have tenant scope. Uniqueness for school-owned codes is tenant-aware, e.g. `(tenant_id, student_number)`.
- Foreign-key relationships must not connect School A records to School B records. Use appropriate constraints and isolation tests, not only independent ID existence checks.
- Enrollment records preserve academic history; do not overwrite a student's class every year.
- Curriculum hierarchy is curriculum → unit → topic → concept. Concept relationships represent prerequisites/related/part-of links without a graph database initially.
- Learning objects are structured, extensible, versioned, and linked to sources/reviews.
- Content workflow includes DRAFT, GENERATING, GENERATED, IN_REVIEW, CHANGES_REQUESTED, APPROVED, PUBLISHED, and ARCHIVED; stage-specific transitions and permissions remain to be designed.
- Mastery is scoped by student/concept/tenant, with score, confidence, attempt/success counts, practice/success/review timestamps, algorithm version, and explanatory evidence/history.
- Assessment answers and practice attempts are evidence, not only final aggregate marks.
- XP uses a transaction ledger; retry/idempotency rules must prevent duplicate rewards.
- Use deliberate retention/archive/deletion policies. Do not add soft deletion everywhere without understanding privacy and academic-history needs.
- Never store large uploaded binaries in PostgreSQL. Index actual access paths and introduce vector indexes based on corpus/query requirements.

## Migration strategy

Stage 1 establishes local infrastructure and migration tooling. Identity/tenancy/academic/curriculum schemas then arrive with their respective approved tasks and tests. Do not materialize the entire conceptual table list at once. RLS is an investigation requiring connection/session/Prisma compatibility analysis before adoption.

---

# Stage 1 implementation (historical accepted baseline)

## Selected versions

| Component            | Version                         | Why                                                                                                                  |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL           | 17.11 (Debian 17.11-1.pgdg12+2) | Current major with a supported release window. Long enough to be settled, recent enough to receive security fixes.   |
| pgvector             | 0.8.7                           | Ships in the same image as PostgreSQL 17, so extension availability needs no separate install.                       |
| Prisma CLI/client    | 7.10.0                          | Current stable major/minor. Prisma 8 exists only as a release candidate and was deliberately not used.               |
| `@prisma/adapter-pg` | 7.10.0                          | Prisma 7 requires a driver adapter for every connection; this is the PostgreSQL/`pg` adapter.                        |
| `pg`                 | 8.23.1                          | Required by `@prisma/adapter-pg` (`^8.16.3`); the current stable driver release.                                     |
| Redis                | 8.8.3                           | Mature settled patch line of the Redis 8 series, chosen over the newer 8.10 line and over the floating `latest` tag. |
| ioredis              | 5.11.1                          | Mature line, and the client BullMQ's own guidance is written against. Avoided the brand-new 6.0.0 major.             |

Exact installed versions live in `packages/database/package.json`, `packages/redis/package.json`, and `pnpm-lock.yaml`.

## Local infrastructure

`infrastructure/docker-compose.yml` provides PostgreSQL and Redis for development only. Both use named volumes
(`tsms-postgres-data`, `tsms-redis-data`) so ordinary container restarts and recreations do not destroy data.
Ports are bound to loopback only. All credentials in that file are throwaway local values.

A one-shot `postgres-test-init` container creates the `tsms_test` database. It is idempotent and exits after
running. Full commands are in `infrastructure/README.md`.

> **Closure correction (2026-10-07).** The `postgres-test-init` container was removed. `docker compose up --wait`
> treats a service that exits as a failure, so `pnpm infra:up` returned a non-zero exit code even when both
> services were healthy. The container was also redundant: `prisma migrate deploy` creates its target database when
> it does not exist, and `pnpm db:test:migrate` calls exactly that against the guarded `TEST_DATABASE_URL`. Verified:
> after `pnpm infra:reset && pnpm infra:up`, `pnpm test:integration` creates `tsms_test`, applies both migrations,
> and passes.

## Database package

`packages/database` is the canonical home for Prisma. Applications must not import the generated client tree
directly; they import `@tsms/database`.

```
packages/database/
├── prisma.config.ts                 Prisma 7 CLI configuration
├── prisma/
│   ├── schema.prisma                generator + datasource + the single probe model
│   └── migrations/                  committed, reviewed SQL
├── scripts/migrate-test.mjs         applies migrations to the disposable test database
├── src/
│   ├── client.ts                    client factory, ping, close, re-exports
│   ├── testing.ts                   test-database safety guard
│   ├── generated/prisma/            Prisma Client output (gitignored, regenerate)
│   └── index.ts
└── tests/                           safety (unit) + database (integration)
```

### Prisma 7 specifics that matter

- CLI configuration lives in `prisma.config.ts`, not a `prisma` key in `package.json`.
- `prisma generate` emits plain TypeScript into `src/generated/prisma` and this package compiles it with its own
  `tsc` build, so applications import emitted JavaScript. `importFileExtension = "js"` is required for that to
  work; the `ts` form is only for running generated TypeScript directly under `tsx`.
- `PrismaClient` **requires** a driver adapter in Prisma 7. `createDatabaseClient` always supplies `PrismaPg`.
- `datasource.url` is read from `process.env.DATABASE_URL` directly rather than through Prisma's `env()` helper so
  that `generate` and `validate` keep working where no database exists.
- `migrate dev` no longer runs `generate` automatically; run `pnpm db:generate` explicitly.

## Schema state

One model only: `InfrastructureProbe`, mapped to `infrastructure_probes`.

This is deliberately **not** a business concept. It exists so Stage 1 can prove end to end that migrations apply,
that the generated client reads and writes through the typed query layer, and that integration tests can verify a
real query round trip. It has no tenant, school, or student meaning. It must be replaced or dropped when the first
real domain model lands.

**Closure review (2026-10-07) confirmed:**

- No tenant, school, student, or business semantics. Columns are `id`, a unique `label`, and `createdAt`.
- Documented as infrastructure scaffolding in the schema file itself, here, and in `packages/database/src/client.ts`.
- No application logic depends on it. The only references outside the schema are
  `packages/database/tests/database.integration.test.mjs`, which uses it to prove the typed query layer and the
  unique constraint. Neither `apps/api` nor `apps/worker` references it.
- Removal/replacement when the first genuine domain model arrives is documented in three places: the schema
  comment, this section, and `project-state.json`.
- Migration history is **not** casually rewritable after Stage 1 acceptance. Once `ebb3111` is followed by a Stage 1
  commit and that baseline is accepted, the two committed migrations become the reviewed history that
  `migrate deploy` replays in staging and production. Do not edit or renumber them. To remove the probe, add a new
  forward migration that drops the table alongside the first domain migration; never rewrite an applied migration.

## Migrations

Two committed migrations:

1. `20261007121807_init_infrastructure_probe` — creates `infrastructure_probes`.
2. `20261007121808_enable_pgvector` — `CREATE EXTENSION IF NOT EXISTS vector`.

`migrate dev` and `migrate deploy` behave as documented for Prisma 7:

| Command            | Use                                     | Shadow database | Drift detection | Resets data | Generates artifacts |
| ------------------ | --------------------------------------- | --------------- | --------------- | ----------- | ------------------- |
| `pnpm db:migrate`  | Local development only                  | Required        | Yes             | No          | No                  |
| `pnpm db:deploy`   | Staging and production                  | Not used        | No              | No          | No                  |
| `pnpm db:status`   | Check applied/pending state             | No              | No              | No          | No                  |
| `pnpm db:reset`    | Local development only; **destructive** | Yes             | Yes             | **Yes**     | No                  |
| `pnpm db:generate` | Regenerate the client after any change  | No              | No              | No          | **Yes**             |

Production must use `db:deploy`. It applies committed, reviewed SQL and never invents a migration. `db:reset`
destroys local data and must never be pointed at staging or production.

### pgvector

pgvector is enabled by a reviewed migration, not by a Docker-only init script, so the capability is reproduced in
staging and production by the same command. Stage 1 creates **no** vector columns, indexes, embeddings, or
retrieval code; it only establishes that the extension is available. A later, separately approved stage adds
vector usage as ordinary migrations against the already-enabled extension.

The role that applies migrations must be permitted to `CREATE EXTENSION`. In local Docker Compose the `tsms` role
is a superuser. In staging and production a DBA may need to run the statement once before the first
`migrate deploy`.

## Client lifecycle

`createDatabaseClient(connectionString, options)` returns one Prisma client; `pingDatabase` and `closeDatabase`
handle verification and shutdown.

- **One client per process.** It owns a connection pool and is safe to share across concurrent requests. A client
  per request would mean a pool per request.
- **Connections are established lazily by the driver.** The process starts and reports liveness even when
  PostgreSQL is unavailable; readiness reports the outage instead.
- **Shutdown is explicit.** In the API, `DatabaseService.onApplicationShutdown` closes the pool. In the worker,
  closing the health server closes it.
- **Logging is off by default** so a failure cannot write a raw driver error containing connection details.
- **`connectionTimeoutMillis` is set explicitly** (5s in the services). Prisma 7 delegates to `pg`, whose default
  has no connect timeout, which would let a readiness probe hang.

The NestJS integration is a thin adapter in `apps/api/src/infrastructure/`. It does not contain Prisma setup;
it only constructs `DatabaseService` from already-validated configuration.

## Testing workflow

Unit tests run with `pnpm test` and require **no Docker**. Integration tests require the Docker Compose services
and run with `pnpm test:integration`, which first applies migrations to the disposable test database.

| Suite                | Command                                         | Needs Docker | Needs a database  |
| -------------------- | ----------------------------------------------- | ------------ | ----------------- |
| Unit                 | `pnpm test`                                     | No           | No                |
| Database integration | `pnpm --filter @tsms/database test:integration` | Yes          | Yes (`tsms_test`) |
| Redis integration    | `pnpm --filter @tsms/redis test:integration`    | Yes          | Yes (Redis db 1)  |
| Both                 | `pnpm test:integration`                         | Yes          | Yes               |

### Test-database safety

Destructive integration work is guarded in code, not by documentation or memory.
`assertDisposableTestDatabase` in `packages/database/src/testing.ts` refuses to let a connection be opened unless:

1. the URL is a PostgreSQL URL,
2. the database name ends with `_test`, and
3. the host is loopback.

`assertDisposableTestRedis` in `packages/redis/src/testing.ts` refuses unless the URL selects a **non-zero**
logical database, which keeps tests away from the application connection's database `0`.

Rejection messages never include the URL, because the URL carries a password. `pnpm db:test:migrate` routes
through the same guard, so it cannot be pointed at the application database either.

## Multi-tenancy preparation

ADR-002 (shared database, shared schema, tenant-scoped records) and `docs/architecture/MULTI_TENANCY.md` are
unchanged by Stage 1. Stage 1 implements **no** tenant tables, tenant IDs, tenant middleware, query filters, or
Row-Level Security.

What Stage 1 does provide for Stage 3:

- `PrismaClient` is stateless with respect to tenants, so one shared client is correct under shared-schema
  multi-tenancy. No per-tenant client is needed and none was built.
- `packages/database` re-exports `PrismaClient` and `DatabaseTransactionClient` (`Prisma.TransactionClient`) so
  Stage 3 repositories can be typed against the package without reaching into generated internals.
- No table in Stage 1 commits to a primary-key or uniqueness scheme that would prevent a later `tenant_id` column
  plus tenant-aware composite unique constraints and foreign keys.
- No global-only assumption exists anywhere in the foundation: the probe table is deliberately infrastructure-only
  and is scheduled for replacement.

## Transactions

No transaction abstraction was built, and none is needed yet. `PrismaClient.$transaction` is available directly and
is covered by an integration test that verifies both commit and rollback behaviour. Stage 3 domain services should
pass a transaction client to repositories rather than reaching for a global client inside a transaction, which is
why `DatabaseTransactionClient` is part of the package's public surface.

## Connection pooling

No external pooler is introduced. Prisma 7 delegates pooling to `pg` through `@prisma/adapter-pg`, and that is
what Stage 1 uses. Note that `pg` defaults differ from Prisma 6: no connection timeout and a short idle timeout.
The services set an explicit connect timeout; idle and pool-size tuning is deployment-dependent.

Production pooling strategy (PgBouncer in transaction or session mode, managed pooler, or direct connections) is
**deferred to a later production-architecture stage**. It depends on the deployment target, which does not exist
at Stage 1, and it interacts with RLS session variables, which is part of the RLS investigation already noted as
requiring separate analysis.

## Deferred decisions

| Decision                      | Why deferred                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ                        | The architecture plans queues for workers, but no stage has a job to run. Adding BullMQ now would be unused complexity. It arrives with the first stage that needs a queue. A BullMQ worker additionally requires `maxRetriesPerRequest: null`, which the Stage 1 client does not set. |
| Redis caching / rate limiting | No cache or rate-limit requirement exists yet, and both need tenant-scoped keys.                                                                                                                                                                                                       |
| S3-compatible object storage  | Resource upload arrives at the resources/content stage. No MinIO or S3 is provisioned.                                                                                                                                                                                                 |
| Row-Level Security            | Requires connection/session/pooling analysis, as recorded in `docs/architecture/MULTI_TENANCY.md`.                                                                                                                                                                                     |
| Production connection pooler  | Deployment-dependent; see above.                                                                                                                                                                                                                                                       |
| Vector indexes and embeddings | pgvector is available; usage belongs to the semantic-retrieval stage.                                                                                                                                                                                                                  |
| Multi-file Prisma schema      | Unnecessary while the domain model is a single probe table. Revisit when domain groups arrive.                                                                                                                                                                                         |

## Stage 1 dependency advisories

Stage 1 introduced three new advisories through `prisma@7.10.0`. All three were **remediated**, not accepted:

| Advisory            | Package      | Was    | Fix                |
| ------------------- | ------------ | ------ | ------------------ |
| GHSA-ggr8-5vv4-36mx | deepmerge-ts | 7.1.5  | override to 8.0.2  |
| GHSA-3f6p-5ww8-9rcr | mysql2       | 3.15.3 | override to 3.24.5 |
| GHSA-rgwj-5xj2-c3m3 | mysql2       | 3.15.3 | override to 3.24.5 |

Rationale for each override, including the deepmerge-ts major-version compatibility analysis, is recorded in
`pnpm-workspace.yaml` and `docs/security/DEPENDENCY_RISK_REGISTER.md`. `pnpm audit --audit-level=high` returns to
exactly its Stage 0 baseline after these overrides, and the full validation suite plus the Prisma CLI were
re-verified afterwards.

The two Stage 0 advisories (node-forge, braces) remain installed and unresolved under their owner-accepted
temporary dispositions. See `docs/security/DEPENDENCY_RISK_REGISTER.md`.

## Stage 2.1 - global identity persistence

Owner authorization is limited to identity schema and migration. No login, password hashing, session
validation, token generation/consumption, provisioning, event recording, or tenant/RBAC behavior exists.

The new forward migration is `20261007210000_identity_schema`. It adds six tables and two enums, with
no data deletion or modification of the two accepted Stage 1 migrations. InfrastructureProbe remains:
its existing independent client/transaction regression tests still use it. This deliberately defers the
historical removal plan above; a future forward migration must replace that coverage before removing it.

### IDs, naming, and timestamps

Tables use snake_case mappings; columns keep the existing Prisma camelCase convention. Every new model
uses a native PostgreSQL UUID primary key with `@default(uuid(7))`. The baseline had no production ID
policy beyond an integer test probe; UUIDv7 implements the owner's UUID-style identity requirement.
Prisma generates these IDs, not PostgreSQL: direct SQL writers must provide a UUID. See the
[Prisma v7 schema reference](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference#uuid).

Dates retain Stage 1's DateTime / TIMESTAMP(3) convention and represent UTC instants. `createdAt` and
`occurredAt` default to database current time. User and credential `updatedAt` are maintained by Prisma;
direct SQL writers must supply/update them. No database update trigger or timezone policy change is added.

### Models and constraints

| Model                  | Purpose and invariants                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User                   | Global identity; required presentation email, unique normalizedEmail, displayName; ACTIVE/DISABLED only; nullable emailVerifiedAt. No school, membership, role, or permission attributes.                                                          |
| PasswordCredential     | Required passwordHash text, unique userId (at most one per identity), passwordChangedAt and creation/update times. Users may exist without a credential. No hashing implementation, algorithm dependency, plaintext, or reversible password field. |
| Session                | Required unique tokenHash and owner; required expiry; nullable lastSeenAt/revokedAt. No raw bearer token.                                                                                                                                          |
| PasswordResetToken     | Required unique tokenHash, owner, expiry; nullable usedAt for later single-use enforcement.                                                                                                                                                        |
| EmailVerificationToken | Required unique tokenHash, owner, expiry; nullable usedAt. No delivery or consumption behavior.                                                                                                                                                    |
| AuthenticationEvent    | Nullable userId for unknown identities, constrained event enum, occurredAt and optional requestId. No arbitrary metadata column.                                                                                                                   |

Normalized email uniqueness is enforced in PostgreSQL. Normalization itself remains future writer behavior:
trim surrounding whitespace and lowercase, retaining presentation email. No provider-specific transformations,
normalization service, or public registration. The database does not transform or validate email syntax.
Hash columns deliberately do not pin an encoding or password algorithm before Stage 2.2. Their names and
contracts require hashes; a TEXT column cannot prove a value is a digest. No production writer exists yet.

### Foreign keys and lifecycle

All five user foreign keys explicitly use ON DELETE RESTRICT and ON UPDATE RESTRICT. This prevents an
accidental user deletion or ID reassignment from destroying credentials, sessions, recovery records, or known
security-event attribution. Nullable event ownership is for genuinely unknown identities, not automatic
anonymization on deletion. ACTIVE/DISABLED is persistence support only; account disabling is not implemented.

These constraints are not a complete retention framework or immutable audit store: privileged explicit
child deletion remains possible, and a user with no dependents can be deleted. Retention, approved erasure,
and event-writer permissions require later authorization. Tests clean up only their own synthetic rows,
explicitly deleting children before parents. No cascade or broad truncate is needed.

### Index rationale

- Unique normalizedEmail supports global identity lookup and duplicate prevention.
- Unique PasswordCredential.userId enforces one credential and covers owner lookup without another index.
- Unique tokenHash on each token-bearing table supports direct digest lookup and duplicate prevention.
- Each token-bearing table has userId for owner lookup/invalidation and expiresAt for expiry lookup/cleanup.
- AuthenticationEvent has (userId, occurredAt) for a user's chronological security history; its leading
  column also supports foreign-key checks. No metadata, status, or speculative global event indexes.

### Security-event metadata boundary

Only the nine approved event concepts are in AuthenticationEventType. Optional JSON metadata is omitted
until a bounded sanitized security-metadata contract exists. Future code must never persist passwords,
raw tokens, Authorization/Cookie headers, or request bodies. requestId is only a correlation identifier;
its validation belongs to the future event writer. This task adds no event-recording behavior.
