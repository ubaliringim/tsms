# Current task: Stage 2.3 - Secure Session Foundation

Owner: TeamStack Technologies LTD

Stage 0 and Stage 1: ACCEPTED. Stage 2.1 and 2.2: ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2.3: LOCALLY VALIDATED / READY FOR OWNER REVIEW; NOT ACCEPTED.
Stage 2 overall: NOT ACCEPTED. Stage 2.4 and later: NOT STARTED / UNAUTHORIZED.

## Starting state

main at 333ee77d26bc9b9a2d7d631bfbf2415d87f22232, matching origin/main, clean working tree.
Inspected operating rules, state, roadmap, security/database architecture, accepted Prisma
schema/migrations, API/credential conventions, test guards, package configuration and CI.
Prior handoff: [Stage 2.2 archive](completed/stage-2-2-password-credentials.md), preserved
with relative links adjusted for its new directory. No history or follow-up removed.

## Implementation and security decisions

[Session security design](../docs/security/SESSIONS.md) defines the exact contract.
Three internal identity files implement fixed safe error classifications, token primitives,
and a Prisma SessionService. No HTTP/Nest registration or password/login coordination.

- Node CSPRNG generates 32-byte (256-bit) opaque secrets, 43-character canonical base64url.
- SHA-256 over the exact UTF-8 token string; only lowercase hex digest persists.
- createSession requires an existing ACTIVE User; returns token/sessionId/expiresAt once.
- Seven-day fixed absolute lifetime, explicit UTC-compatible dates, injected clock for tests.
- validateSession checks current row, revocation, strict expiry and current User status;
  returns only userId/sessionId/expiresAt. No status cache, lastSeenAt writes or sliding expiry.
- Ownership and revokedAt=null are enforced in the individual atomic update. Repeated
  revocation preserves timestamp; cross-user/missing IDs fail without changing the row.
- Revoke-all updates only that user's unrevoked, unexpired rows and returns a count.
- Malformed input and expected rejection have fixed codes; underlying failures are sanitized
  SERVICE_FAILURE without original error messages/causes. No secret logging or fake success.

Creation and disabling are not fully serialized: an insert racing with disable can succeed,
but validation rechecks current account status. Creation outside revoke-all's update snapshot
can survive. In-flight validation can race with later changes; no perpetual authorization grant.
A future workflow can coordinate all writers with a per-user transaction lock or an approved
session-generation schema extension. Neither is implemented. Re-enabling never clears revocation;
unrevoked, unexpired sessions may validate again. No schema or migration changes are needed.

## Tests

Focused unit: 12 PASS. Token entropy source/format/uniqueness, deterministic hashing, canonical
encoding and unused-bit rejection, immutable policy, invalid inputs before database access,
sanitized failures in all four operations, invalid clock and post-query expiry sampling.
Focused database integration: 17 PASS. Hash-only creation, ACTIVE/DISABLED/missing users,
unique digest constraint, minimal context, no last-seen writes, exact expiry and resurrection
checks, current status, disable/re-enable restoration, ownership, idempotence, revoke-all
isolation/history, concurrent creation and revocation, disable/create race, and revoke-all/create
limitation.
All fixtures use guarded TEST_DATABASE_URL and child-first scoped cleanup. No fallback,
truncation, sleeps, token/hash snapshots, or weakened safety rules.

## Validation

- pnpm install --frozen-lockfile: PASS; dependency graph and lockfile unchanged.
- pnpm db:generate: PASS; Prisma 7.10.0; no schema/migration modifications.
- pnpm lint: PASS; zero warnings.
- pnpm typecheck: PASS; 11 tasks, unchanged tasks used Turbo cache.
- pnpm test: PASS; 74 unit/toolchain tests (73 Vitest plus one Node; 36 API tests).
- pnpm build: PASS; seven build tasks, applicable cache reuse.
- pnpm test:integration: PASS; 68 cases (35 database, eight Redis, 25 API including 17 new), none skipped; three migrations, none pending.
- pnpm audit --audit-level=high: EXPECTED FAIL, exactly two accepted high advisories:
  node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. No new finding or suppression.
- pnpm format:check and pnpm check: PASS; applicable existing Turbo caches reused.
- pnpm smoke: PASS, 16 assertions; PostgreSQL and Redis reachable.
- pnpm mobile:check and pnpm mobile:export: PASS, Android 578 modules.
- git diff --check and final security/state review: PASS.

## Boundaries and follow-ups

No login/logout endpoints, cookies, JWTs, middleware, refresh, recovery, cleanup worker,
auth-event recording, tenant membership, RBAC or UI. No dependency, configuration, CI,
accepted schema/migration, password primitive or test-safety changes.

Preserve both accepted advisories, scoped Prisma overrides, concurrent Prisma generation
EEXIST, Actions Node 20-to-24 warning, Ubuntu migration, native/store/non-amd64 limitations,
existing infrastructure/toolchain issues, InfrastructureProbe retirement through a forward
migration, and Stage 2.2 portability/capacity/policy-evolution reviews.
New limitations: documented creation/disable/revoke-all races; future coordinated atomic
workflows need authorization. Hosted Stage 2.3 verification has not run.

All changes remain uncommitted. Recommended commit only: feat: add secure session foundation.
Exact next action: owner reviews Stage 2.3 implementation and security results. DO NOT start Stage 2.4, commit, push or deploy without explicit authorization.

Final review added an exact 36-character length check alongside the anchored UUID pattern.
Takeover verification corrected the earlier claim about it: the length check is **redundant
defence-in-depth, not the mechanism that rejects trailing terminators**. Because the pattern
ends with a specific class `[0-9a-f]{12}`, JavaScript's `$`-before-final-line-terminator
behaviour cannot apply, and the anchored regex alone already rejects `\n`, `\r`, U+2028 and
U+2029. Verified empirically against the compiled service. Both checks are retained because
the length check is cheap and removes reliance on that subtlety if the pattern ever changes.
A new unit test now pins the rejected shapes (all four line terminators, truncation,
extension, braces, `urn:uuid:` prefix, invalid hex) and asserts that a genuine uppercase
UUID reaches the database, so the rejection cannot pass vacuously.

Takeover verification also found the documented re-enable behaviour had no coverage. A new
integration test now pins it in both directions: disabling rejects an otherwise valid session
with USER_DISABLED, re-enabling restores it with its original absolute expiry, and expiry is
still enforced afterwards. No production behaviour, timeout, policy or test guard was
weakened. Relative Markdown links resolve; accepted stage records and all existing security
dispositions/follow-ups were compared with baseline and preserved.

## Changed files

- PROJECT_STATE.md
- apps/api/src/identity/session-error.ts
- apps/api/src/identity/session-token.ts
- apps/api/src/identity/session.service.ts
- apps/api/tests/session.integration.test.mjs
- apps/api/tests/session.test.mjs
- docs/security/PASSWORD_CREDENTIALS.md
- docs/security/SESSIONS.md
- project-state.json
- tasks/CURRENT.md
- tasks/ROADMAP.md
- tasks/completed/README.md
- tasks/completed/stage-2-2-password-credentials.md

No files deleted. All 13 files remain uncommitted; nothing staged, pushed, or deployed. Takeover review added the two tests and documentation corrections described above; it did not change production code, schema, migrations, dependencies, or safety guards.
