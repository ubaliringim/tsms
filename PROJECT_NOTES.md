# Project Notes

## Current scope

- We are preparing to build a full-scale project.
- The user will share the project context and requirements.
- The user has now authorized Stage 0 through an explicit implementation prompt. Earlier notes-only restrictions are historical; Stage 1 and product functionality remain unauthorized.

## Confirmed requirements

- Keep a running record of the information shared, decisions, open questions, and concise planning rationale.

## Source reviewed

- Shared conversation: https://chatgpt.com/share/6ac5f4a3-17fc-83ea-a929-addb938ba7db
- Page title: "Duolingo Explained". Reviewed on 2026-10-07 using the embedded conversation data.
- This record summarizes the discussion; it is not a verbatim transcript or a finalized implementation specification.
- The source contains user requirements and assistant-authored design proposals. Those are distinguished below. Examples of schools, students, metrics, domains, prices, and code in that discussion are illustrative, not provisioned resources or validated business results.

## Explicit user requirements from the shared conversation

- Build a serious, workable, full-scale application intended to go live.
- Serve primary and secondary school students, including learning at home.
- Transform curricula and resources uploaded by teachers or school management into bite-sized learning experiences inspired by Deepstash, with useful Duolingo-style practice and engagement features.
- Each school should experience the platform under its own school name while sharing one underlying platform.
- Company: **TeamStack Technologies LTD**. Working platform acronym: **TSMS**.
- The user supplied "Teamstack Schools Management Systems"; subsequent draft specifications use "TeamStack School Management System". Preserve this naming distinction until the final wording is settled.
- UI/UX quality matters strongly, alongside a capable backend and clear processing pipelines.
- Storage and document-processing costs need consideration.
- Provide useful teacher and school-management dashboards.
- Explore focus functionality to reduce distraction from other apps while learning.
- Support continuity when switching between Codex, Copilot, OpenCode, or other coding agents. Project context and unfinished work must survive agent changes.
- Commercial viability and revenue matter; no final pricing or financial assumptions were established.

## Product direction in the draft specifications

The central learning loop is: school resources → curriculum concepts → teacher-approved learning objects → student learning and practice → concept mastery → adaptive revision → teacher insights.

- School-approved curriculum is the learning source of truth. AI assists with extraction, generation, explanations, and insights.
- Mastery is concept-based and distinct from XP, time spent, or content completion.
- Teachers review generated curriculum content before publication. Preserve source references and review history.
- One multi-tenant platform serves all schools, with school-specific branding and isolated data.
- Build production foundations in stages; the full vision does not imply implementing every capability in the first release.

### Four experiences

| Experience   | Intended responsibilities                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TSMS Student | Personalized home, subjects, learning paths, cards, questions, contextual AI help, practice, revision, progress, assignments, and engagement features. |
| TSMS Teach   | Classes, curriculum, resource upload, Content Studio, content review/publishing, assessments, student mastery, and targeted interventions.             |
| TSMS Admin   | School users, academic structure, enrollment, curriculum oversight, reports, branding, settings, subscriptions, and school analytics.                  |
| TSMS Control | TeamStack tenant onboarding, plans, quotas, feature flags, usage, system health, support, and audited platform operations.                             |

### Learning and content behavior

- Use an extensible learning-object model: concepts, definitions, examples, diagrams/images, approved videos, facts, questions, challenges, reflections, and summaries.
- Contextual AI actions include explanations, hints, alternative examples, and practice tied to the current concept and approved sources.
- Separate learning sessions, informal practice, and formal assessments.
- Consider correctness, difficulty, attempts, hints, recency, and repeated success in mastery; the exact V1 algorithm remains to be specified.
- Start recommendations with explainable rules using curriculum position, weak concepts, prerequisites, review due dates, and teacher assignments.
- Proposed engagement features include XP, streaks, levels, achievements, missions, and configurable leaderboards.
- Student design should be visual, simple, and suitable for age and device; teacher design should prioritize actions and learning gaps; management design should show school-wide trends.

### Content pipeline and cost controls

- Upload → file/security validation → extraction → structure/chunking → curriculum mapping → concept extraction → embeddings/generation → automated validation → teacher review → approval/publication.
- Teachers can edit, reorder, regenerate, reject, preview, and approve generated content.
- Processing runs asynchronously with visible stage status, retries, failure handling, and operator visibility.
- Retain provenance: original resource, page/section, chunks, generation/provider/model version, reviewer, and publication state.
- Reuse approved content across authorized students. Reserve dynamic generation for interactions that need personalization.
- Store files in private object storage; store structured records in PostgreSQL. Apply storage and AI quotas and measure usage.
- Storage proposals include content hashes/deduplication, avoiding repeated processing, and deliberate retention/media policies; exact policies and provider remain unresolved.

## Proposed technical baseline from the prior discussion

These are the previous assistant's architectural recommendations, carried forward for review rather than newly selected or installed in this workspace.

| Area                | Proposed choice                                                              |
| ------------------- | ---------------------------------------------------------------------------- |
| Structure           | TypeScript monorepo; modular monolith API with background workers            |
| Workspace           | pnpm and Turborepo                                                           |
| Web                 | Next.js; initially combine Teach and Admin with permission-based access      |
| Mobile              | React Native and Expo, with Android a priority                               |
| Platform operations | Separate TSMS Control application/security boundary                          |
| API                 | NestJS with explicit domain-module interfaces                                |
| Database            | PostgreSQL and Prisma; shared schema with tenant-scoped records              |
| Retrieval           | pgvector initially; tenant and publication filters enforced during retrieval |
| Cache/jobs          | Redis and BullMQ                                                             |
| Files               | S3-compatible private object storage                                         |
| AI                  | Provider abstraction; TypeScript workers initially, Python only where needed |
| Validation/testing  | Zod/backend DTO validation; Vitest/Jest, API integration tests, Playwright   |

- Keep identity separate from tenant membership so one person can belong to multiple schools.
- Use permissions beneath roles, plus object-level checks for class, subject, ownership, assignment, and resource state.
- Keep domain boundaries for identity, tenancy, academics, curriculum, resources, content, learning, assessments, mastery, recommendations, gamification, analytics, billing, audit, and operations.
- PostgreSQL owns business state; files live in object storage; events provide learning evidence; mastery and analytics are derived; embeddings are retrieval indexes; AI output is not authoritative state.
- Use events to drive mastery, XP, recommendations, and reporting. Aggregate analytics in background jobs.
- Avoid starting with many microservices, Kafka, or a dedicated graph database.
- Browser and mobile clients share backend contracts. Offline caching/sync is a future capability to accommodate, not an immediate implementation instruction.

## Data-model direction

- Tenant/school, user, membership, roles/permissions, student/teacher profiles.
- Academic sessions, terms, configurable levels, class groups, subjects, teacher assignments, and enrollment history.
- Curriculum → units → topics → concepts; prerequisite and related-concept relationships.
- Resources, extracted chunks, learning objects, source links, generation metadata, and review workflow.
- Questions/options, assessments, attempts/answers, learning sessions/items, practice attempts, and targeted assignments.
- Concept mastery with confidence, evidence/history, algorithm version, and revision scheduling.
- XP ledger, streaks, achievements, append-oriented learning events, and analytics aggregates.
- Branding/domains, feature flags, plans/subscriptions/entitlements, usage counters, notifications, and audit logs.
- Use tenant-aware uniqueness and relationships; prevent references linking records from different tenants.
- Preserve academic history rather than overwriting a student's class each year.
- Introduce schemas through staged migrations rather than implementing the entire conceptual model upfront.

## Security and privacy direction in the source

- Enforce authenticated identity → verified tenant membership → permissions → resource authorization on every protected action.
- Never trust client-supplied tenant IDs as authorization. Tenant-aware repositories should make missing tenant scope difficult.
- Isolate school data across APIs, database relationships, files, caches, jobs, exports, and AI retrieval. Explicitly test cross-tenant access attempts.
- Investigate PostgreSQL row-level security as defense in depth; the source does not establish a finished RLS design.
- Use strong password hashing, secure/revocable sessions, reset protections, validation, rate limits, and applicable web protections.
- Keep platform operations separate from access to student records. Proposed support access is scoped, time-limited, and audited.
- Minimize children's data and AI-provider payloads. Restrict profile/leaderboard visibility and establish retention/deletion policies.
- Treat uploaded/retrieved content as untrusted data, not AI instructions. Validate and ground generated output before teacher approval.
- Validate and scan uploads; authorize private file access using expiring signed URLs.
- Keep secrets out of source control and logs. Sanitize operational logs and client errors.
- Separate development, staging, and production; use synthetic development data.
- Include backups, restore testing, monitoring, incident procedures, and eventual recovery objectives.
- The source calls for legal/privacy review before commercial launch; this note records that requirement without claiming compliance has been assessed.
- Never bypass authentication, authorization, tenant isolation, validation, or audit controls to make implementation or tests pass.

## Scope and sequencing proposed in the source

- First production scope: tenancy/auth/permissions/branding; academic core; curriculum/resources; Content Studio with review; student learning and questions; basic mastery/revision/recommendations; teacher/admin views; platform operations, quotas, audits, monitoring, and backups.
- Later scope: full parent application, sophisticated adaptive models, complex leaderboards, predictive analytics, deeper offline synchronization, and managed-device controls.
- Focus Mode was discussed with platform limitations: the prior conversation does not establish that an ordinary app can universally block other apps. Device-management feasibility needs verification before promising or implementing it.
- Suggested domain sequence: foundation → identity/tenancy/permissions → academics → curriculum → resources/content → student learning → assessments → mastery → analytics → billing/operations.
- Exact stages, acceptance criteria, launch scope, and dates have not yet been finalized.

## Agent continuity requirement

- The source proposes repository-owned documentation: AGENTS.md, README, PROJECT_STATE.md, current task, roadmap, architecture decisions, handoff notes, and optionally machine-readable state.
- Record completed/remaining work, touched files, actual test results, blockers, and the precise next action.
- Future agents should inspect existing work and decisions before editing; preserve unfinished changes and avoid silent architectural redesign.
- These are future documentation proposals. They have not been created because the current instruction authorizes only this notes file.

## Prior conversation stopping point

Four substantial draft specifications appear in the conversation:

1. TSMS Product Definition v1.0.
2. TSMS System Architecture v1.0.
3. TSMS Data Model & Database Architecture v1.0.
4. TSMS Security, Privacy & Multi-Tenancy v1.0.

The proposed next work was the Development & Agent Framework and a staged implementation roadmap. No implemented application or completed tests are evidenced by this conversation.

## Development & Agent Framework v1.0 — additional supplied context

The user supplied the next part of the planning conversation after the shared link. It contains the Development & Agent Framework v1.0 and says the next deliverable would be a complete Stage 0 implementation prompt. The quoted invitation to start coding is historical context, not a new instruction to implement in this session.

### Repository memory and intended structure

- Root documents: AGENTS.md, README.md, PROJECT_STATE.md, CHANGELOG.md, and project-state.json.
- Specifications: docs/product/PRODUCT_SPEC.md; docs/architecture/ARCHITECTURE.md, DATABASE.md, MULTI_TENANCY.md, SECURITY.md, and AI_ARCHITECTURE.md.
- Decisions: docs/decisions/ with five initial ADRs listed below.
- Tasks: tasks/ROADMAP.md, tasks/CURRENT.md, and tasks/completed/.
- Applications: apps/web, apps/student-mobile, apps/api, apps/worker, and apps/control.
- Shared packages: ui, types, validation, config, database, auth, events, learning, and ai.
- Supporting directories: infrastructure, scripts, and tests.
- These describe the target organization; they do not require full implementation of every application at bootstrap.
- An earlier outline in the supplied text separates docs/security and docs/database; the detailed framework places these specifications under docs/architecture. Use one consistent layout when implementation is authorized.

### Agent operating protocol

- Before editing: read AGENTS.md, PROJECT_STATE.md, tasks/CURRENT.md, and its referenced specifications; inspect Git status, recent commits, diff, and existing implementation.
- Implement only the approved current task. Do not advance stages, silently redesign architecture, violate accepted ADRs, or overwrite unfinished work.
- Preserve security controls, require trusted tenant context for tenant-owned data, distrust client-supplied tenant identity, and never commit secrets.
- Keep changes small and understandable; add or update applicable tests when behavior changes.
- Before completion: run the task's required checks, verify acceptance criteria, synchronize all state files, document issues, and report changes and validation results.
- A handoff must identify completed work, work in progress, remaining work, changed files, uncommitted changes, actual test outcomes/failures, the exact next action, and constraints for the next agent.
- Git commits should describe coherent changes. Stage completion depends on evidence and review, not an agent's declaration alone.

### State-file responsibilities

- PROJECT_STATE.md: concise current phase/stage/status, last completed work, current work, working/not-implemented capabilities, known issues, next step, and prohibited next-stage work.
- tasks/CURRENT.md: bounded task goal, requirements, exclusions, acceptance criteria, validation commands, and handoff.
- project-state.json: synchronized machine-readable project/company/phase/stage/task/status/nextTask/blocked fields.
- Example statuses, task numbers, passing/failing test counts, and implemented features in the pasted framework are illustrative. They do not describe this workspace's current implementation state.

### Initial architecture decisions to formalize

| ADR     | Decision                                                                  |
| ------- | ------------------------------------------------------------------------- |
| ADR-001 | Modular monolith first.                                                   |
| ADR-002 | Shared-schema multi-tenancy with explicitly tenant-scoped records.        |
| ADR-003 | Mastery attaches to concepts rather than lessons.                         |
| ADR-004 | Generated curriculum content follows teacher approval before publication. |
| ADR-005 | Domain code uses provider-neutral AI interfaces.                          |

### Supplied milestone roadmap

| Stage | Scope                             |
| ----- | --------------------------------- |
| 0     | Engineering Foundation            |
| 1     | Database & Local Infrastructure   |
| 2     | Authentication & Identity         |
| 3     | Multi-Tenancy                     |
| 4     | RBAC & Authorization              |
| 5     | School Onboarding & Branding      |
| 6     | Academic Structure                |
| 7     | Students, Teachers & Enrollment   |
| 8     | Curriculum Engine                 |
| 9     | Resources & Document Processing   |
| 10    | Content Studio                    |
| 11    | Student Learning Core             |
| 12    | Assessment Engine                 |
| 13    | Mastery Engine                    |
| 14    | Recommendations & Spaced Revision |
| 15    | AI Tutor & RAG                    |
| 16    | Gamification                      |
| 17    | Teacher Intelligence              |
| 18    | School Analytics                  |
| 19    | TSMS Control                      |
| 20    | Production Hardening              |

These are engineering milestones, not necessarily separate deployments. Each stage should be divided into bounded tasks with explicit acceptance criteria. Agents receive one current task rather than the entire roadmap as an implementation request.

### Stage 0 boundary

- Goal: establish the engineering foundation and repository memory without product functionality.
- Included in the supplied outline: Git, pnpm, Turborepo, TypeScript, Next.js, NestJS, Expo, shared packages, linting, formatting, testing baseline, environment validation, CI, and documentation/state files.
- Excluded: authentication, Prisma business schema, tenant business logic, school onboarding, students, curriculum, AI functionality, and billing.
- The first bootstrap prompt must carry enough project context to create accurate source-of-truth documents because those documents do not exist yet.
- Future prompts should refer to the repository documents and current task.
- Applicable completion gates: acceptance criteria, lint, typecheck, unit/integration/security/tenant-isolation tests where relevant, build, and updated state/handoff. Each task must specify which gates apply.
- Proposed review cycle: bounded prompt → implementation report → review/fixes → stage acceptance → next prompt.

### Planning observations after this addition

- The missing framework has now been supplied as planning context; it no longer needs to be invented from scratch.
- A roadmap outline now exists, but detailed task breakdowns and concrete Stage 0 acceptance criteria/commands are still missing.
- Security, tenancy-aware design, observability, and verification must be incorporated when relevant throughout development; Stage 20 should consolidate hardening rather than defer basic safeguards until the end.
- Stage 2 identity work must accommodate membership-based authorization even though tenancy and RBAC receive later dedicated milestones.
- Stage 9/10 generation will require the provider abstraction and approval boundaries before the dedicated Stage 15 tutoring/RAG milestone.
- No framework files, scaffolding, dependencies, Git repository, or application code have been created by this addition.

## Decisions

- Use this file as the running project record during discovery.
- Stage 0 implementation is authorized by the latest user prompt. Stop for review before Stage 1.

## Planning notes

- The shared conversation supplies a substantial design baseline, but further material from the user may refine or supersede it.
- Preserve the central relationship between curriculum concepts, approved content, learning evidence, and mastery when refining the design.
- Tenant isolation and publication approval affect every subsystem; they should be acceptance criteria from the first relevant implementation stage.
- Before implementation, resolve concrete contracts, state transitions, failure/retry behavior, and measurable acceptance criteria for each stage.
- The product name includes school management, but the documented first-release emphasis is learning and academic administration. Fees, payroll, transport, and other ERP modules should not be inferred from the name alone.
- Summaries here record decisions and concise rationale, not hidden reasoning or a claim that proposals have been validated.

## Open questions

These are tracking items, not a request for immediate answers while the user is still sharing context.

- Final expanded TSMS name and which prior proposals should be treated as accepted decisions.
- Initial launch schools, classes/subjects, student ages, expected usage, and success metrics.
- Exact first-release web/mobile scope and offline requirements.
- Design references, branding assets, accessibility needs, and age-specific UX.
- Final technology stack, hosting, AI providers, budget, and operational ownership.
- Content licensing, approved-source policies, review roles, and publication/versioning rules.
- Mastery/revision formulas, assessment rules, and boundaries for live AI tutoring.
- Account onboarding/recovery for children, guardian involvement, retention, and support access policy.
- Pricing, quotas, billing timing, storage limits, and media strategy.
- Detailed agent framework and staged roadmap with verification criteria.

## Updates

- 2026-10-07: Created the project record. No implementation started.
- 2026-10-07: Reviewed the shared conversation and captured requirements, prior design proposals, security boundaries, scope, and unresolved decisions. Only this workspace notes file was changed; no application scaffolding or implementation was created.
- 2026-10-07: Recorded the supplied Development & Agent Framework v1.0, target repository structure, agent protocol, five ADRs, Stage 0–20 roadmap, and Stage 0 boundaries. Implementation remains on hold under the user's current instruction.

- 2026-10-07: Explicit Stage 0 prompt received. Final full name is TeamStack School Management System. Current specifications, ADRs, and task/state files now govern implementation; this file preserves discovery history.

- 2026-10-07: Stage 0 engineering foundation implemented and validated. Status PARTIAL: core checks, 15 tests, Expo/Android bundle and smoke checks pass; two unpatched high-severity dependency advisories keep the security gate failing. Current task/state files contain the full handoff. Stage 1 has not started.
