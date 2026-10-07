# System architecture

Status: accepted direction. Stage 0 implements engineering shells only.

## Components and boundaries

Use a TypeScript monorepo managed by pnpm and Turborepo. The API is a **NestJS modular monolith**, with a separately runnable worker. Do not start with many microservices or Kafka. Modules communicate through explicit interfaces rather than each other's internal data access.

| Component             | Direction                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| apps/web              | Next.js Teacher and School Admin application, with permissions controlling access in later stages        |
| apps/control          | Separate Next.js TeamStack operations application/security boundary                                      |
| apps/student-mobile   | React Native/Expo student application; Android deserves first-class attention                            |
| apps/api              | NestJS HTTP API; business modules introduced incrementally                                               |
| apps/worker           | Node/TypeScript asynchronous application; BullMQ workloads introduced when needed                        |
| packages/config       | Shared compiler configuration and server environment validation                                          |
| Other shared packages | UI, types, validation, database, auth, events, learning, and AI added when they own real shared behavior |

PostgreSQL/Prisma will hold business data; Redis supports cache/queues/short-lived state; BullMQ supports jobs; S3-compatible storage holds private files; pgvector initially supports semantic retrieval. Python may be introduced for document/AI workloads when justified. No database, Redis, S3, queue, or provider connection is required by Stage 0.

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

Before launch: backups/PITR where available, restore exercises, storage durability, recovery objectives, abuse controls, and controlled deployment. These are future work, not completed infrastructure.

## Stage 0 tooling choices

Exact installed versions belong to package manifests and pnpm-lock.yaml. Node and pnpm are pinned for reproducibility. Minimal screens contain no dashboard/demo data. Shared packages without consumers are deferred rather than filled with fake APIs. Web/mobile UI sharing is also deferred until real compatible components exist.

Tooling references used during bootstrap: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Expo project setup](https://docs.expo.dev/get-started/create-a-project/), [Turborepo tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks). Version compatibility is checked against registry peer dependencies and Expo's SDK dependency validation.

Server packages use ESM/NodeNext to match NestJS 12. The API development command uses the Nest CLI TypeScript compiler so decorator metadata is preserved; production builds use tsc. ESLint 9.39.5 is retained for eslint-plugin-react peer compatibility; that major is deprecated upstream, so track compatible upgrade support rather than suppress peer checks.
