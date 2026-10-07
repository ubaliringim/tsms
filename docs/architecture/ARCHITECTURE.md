# System architecture

Status: accepted direction. Stage 0 implements engineering shells only.

## Components and boundaries

Use a TypeScript monorepo managed by pnpm and Turborepo. The API is a **NestJS modular monolith**, with a separately runnable worker. Do not start with many microservices or Kafka. Modules communicate through explicit interfaces rather than each other's internal data access.

| Component             | Direction                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| apps/web              | Next.js Teacher and School Admin application, with permissions controlling access in later stages |
| apps/control          | Separate Next.js TeamStack operations application/security boundary                               |
| apps/student-mobile   | React Native/Expo student application; Android deserves first-class attention                     |
| apps/api              | NestJS HTTP API; business modules introduced incrementally                                        |
| apps/worker           | Node/TypeScript asynchronous application; BullMQ workloads introduced when needed                 |
| packages/config       | Shared compiler configuration and server environment validation                                   |
| packages/database     | Canonical Prisma schema, migrations, client factory, lifecycle, and database tests                |
| packages/redis        | Redis client factory, lifecycle, readiness, and Redis tests                                       |
| Other shared packages | UI, types, validation, auth, events, learning, and AI added when they own real shared behavior    |

PostgreSQL/Prisma will hold business data; Redis supports cache/queues/short-lived state; BullMQ supports jobs; S3-compatible storage holds private files; pgvector initially supports semantic retrieval. Python may be introduced for document/AI workloads when justified. No database, Redis, S3, queue, or provider connection was required by Stage 0.

Stage 1 provisions local PostgreSQL and Redis, introduces `packages/database` and `packages/redis`, and separates
process liveness (`/health`) from dependency readiness (`/ready`). It does not create the TSMS domain model.
Implementation detail is recorded in [DATABASE.md](DATABASE.md).

## Logical domains

Auth, Identity, Tenant, School, Academic, Users, Students, Teachers, Enrollment, Curriculum, Resources, Content, Learning, Assessments, Mastery, Recommendations, Gamification, Notifications, Analytics, AI, Billing, Audit, and Platform are eventual domain boundaries, not a requirement to create empty modules now.

Clients → authorized API → domain services → tenant-aware data access. Expensive extraction/generation/reporting runs in workers with explicit statuses, retry policy, failure visibility, and eventual dead-letter handling. Worker messages and cache keys must preserve tenant security boundaries.

## Learning and event flow

Approved content supports student sessions. Learning events feed mastery, recommendations, XP, analytics, and notifications. Consumers must eventually handle retries without duplicate effects; define delivery/idempotency contracts when adding persistence and queues. The design must not pretend that publishing an in-memory event guarantees durable processing.

Learning events may include lesson/card activity, question answers, hints, explanation requests, practice/assessment completion, and focus lifecycle, with tenant/student/class/subject/concept context, timestamps, response time, correctness, attempts, and bounded metadata. Dashboards should use aggregated analytics as volume grows rather than scan all events on every request.

## Storage and scale

Upload once → process once → approve once → serve many. Reuse approved content within its authorization boundary; reserve dynamic AI for personalized interactions. Files stay outside PostgreSQL. External video links/appropriate object assets precede dedicated streaming infrastructure.

Initial deployment consists of web, API, and worker, plus data services. Control remains a distinct surface; components may scale independently. Maintain development/staging/production separation. Do not deploy during Stage 0.

## Operational direction

Plan structured logs, useful metrics/traces, error monitoring, health checks, job visibility, AI/storage usage, and database performance. A Stage 0 liveness response proves only that the process serves HTTP; it is not database readiness or proof of production security.

Stage 1 separates the two. `/health` answers 200 whenever the process is serving and never touches a dependency, so
an infrastructure outage cannot cause an orchestrator to restart a healthy process. `/ready` returns 503 when
PostgreSQL or Redis is unreachable, so a load balancer stops routing requests that need them. Readiness bodies name
only which dependency is down and never include driver messages, connection strings, or credentials.

Before launch: backups/PITR where available, restore exercises, storage durability, recovery objectives, abuse controls, and controlled deployment. These are future work, not completed infrastructure.

## Stage 0 tooling choices

Exact installed versions belong to package manifests and pnpm-lock.yaml. Node and pnpm are pinned for reproducibility. Minimal screens contain no dashboard/demo data. Shared packages without consumers are deferred rather than filled with fake APIs. Web/mobile UI sharing is also deferred until real compatible components exist.

Tooling references used during bootstrap: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Expo project setup](https://docs.expo.dev/get-started/create-a-project/), [Turborepo tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks). Version compatibility is checked against registry peer dependencies and Expo's SDK dependency validation.

Server packages use ESM/NodeNext to match NestJS 12. The API development command uses the Nest CLI TypeScript compiler so decorator metadata is preserved; production builds use tsc. ESLint 9.39.5 is retained for eslint-plugin-react peer compatibility; that major is deprecated upstream, so track compatible upgrade support rather than suppress peer checks.

## Stage 1 tooling choices

`packages/database` and `packages/redis` follow the same pins-as-exact-versions and strict-peer policy. Prisma 7
requires a driver adapter for every connection, and it generates plain TypeScript that this repository compiles with
`tsc`; both details are recorded in [DATABASE.md](DATABASE.md).

Scoped `overrides` in `pnpm-workspace.yaml` are used, always with written justification, when a transitive
dependency has a patched release that its parent pins exactly. The Stage 0 precedent (`xcode>uuid`) and the Stage 1
additions (`deepmerge-ts`, `mysql2`) are both recorded in `docs/security/DEPENDENCY_RISK_REGISTER.md`.
