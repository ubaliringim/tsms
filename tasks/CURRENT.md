# Current task: Stage 2.1 - Identity Schema & Migration

Owner: TeamStack Technologies LTD

Stage 2: AUTHORIZED; Authentication & Identity Specification v1.0 owner approved.
Implementation authorization: **2.1 only**. Stage 2 is NOT accepted.
Status: **ACCEPTED / HOSTED VERIFIED / CLOSED**.
Owner decision recorded on 2026-10-07. Stage 2 as a whole remains NOT accepted.
Stage 1 remains **ACCEPTED** (2026-10-07).
Stage 2.2 - Password Credential Service: **NOT AUTHORIZED**.

## Starting state and scope

Started on main at a4448fa with a clean working tree. Inspected status, log, baseline commit,
unstaged/staged diffs, AGENTS.md, state files, roadmap, architecture/security specifications, accepted
ADRs, Prisma schema/configuration/migrations, database tests and safety guards, environment configuration,
workspace/dependency settings, and CI. The owner's current task defines the approved 2.1 scope; no separate
Stage 2 specification file existed in the starting repository.

Only persistent identity primitives, a new forward migration, relevant tests, and documentation/state
are authorized. No authentication behavior or new dependency is required. The accepted Stage 1 migration
history and hosted CI verification remain preserved; the prior handoff is archived verbatim in
[stage-1-hosted-ci-repair.md](completed/stage-1-hosted-ci-repair.md).

## Implementation decisions

- Six models: User, PasswordCredential, Session, PasswordResetToken, EmailVerificationToken,
  AuthenticationEvent. Identity is independent of school membership and authorization.
- Native PostgreSQL UUID columns; Prisma UUIDv7 defaults. No prior production identity ID convention
  existed (only the integer infrastructure probe). DateTime retains the existing TIMESTAMP(3) convention.
- Database uniqueness on normalized email, credential user ID, and each token hash. No normalization
  service; later writers must trim and lowercase only, preserving presentation email separately.
- All user foreign keys use explicit Restrict on deletion and update. Event user ID can be null when
  identity is unknown, but deleting a known user cannot erase attribution. No retention framework.
- Optional event metadata omitted until a bounded sanitized contract is authorized. Request ID is for
  correlation only, never headers or request bodies. No event recorder exists.
- InfrastructureProbe retained to preserve independent foundation tests; no data needs to be removed.
  Its eventual removal requires a separate forward migration and replacement tests.

Detailed index and persistence decisions: [DATABASE.md](../docs/architecture/DATABASE.md).

## Tests added

26 database integration cases in packages/database/tests/identity.integration.test.mjs:

| Cases | Persistence invariant                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4     | User round-trip/UUIDv7/defaults; normalized-email uniqueness through direct SQL; verification/status/update timestamps; rejected unapproved status. |
| 2     | One credential per user and timestamps; required password hash through direct SQL.                                                                  |
| 3     | Unique token hashes across different users, one case for each token-bearing model.                                                                  |
| 3     | Owner, expiry, default null lifecycle markers, and persisted revocation/consumption markers.                                                        |
| 3     | Known-user event with correlation/time fields; unknown-user event; rejected arbitrary event type.                                                   |
| 5     | Missing user rejected by each of the five foreign keys.                                                                                             |
| 5     | User deletion/ID change rejected by each dependent model; child and attribution retained.                                                           |
| 1     | Live database catalog contains only approved tables and no raw-secret or tenant/RBAC columns.                                                       |

All fixtures are synthetic and scoped to the guarded TEST_DATABASE_URL. No DATABASE_URL fallback,
test skipping, cascade cleanup, or safety-guard changes. The existing nine database cases remain intact
except that migration-state verification now expects the new third migration. Eight Redis cases remain intact.

## Validation and outcomes

Windows / Node 24.16.0 / pnpm 12.3.4, existing TSMS Docker Compose services. Local command logs and
machine-readable results are in gitignored artifacts/stage21. These are the historical local results; completed hosted results are recorded below.

| Command/check                                                | Actual outcome                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile                               | PASS; lockfile unchanged.                                                                                                                               |
| pnpm db:generate                                             | PASS; Prisma 7.10.0 generated client.                                                                                                                   |
| pnpm --filter @tsms/database db:validate                     | PASS.                                                                                                                                                   |
| pnpm --filter @tsms/database exec prisma format --check      | PASS.                                                                                                                                                   |
| pnpm format:check                                            | PASS; rerun after final handoff formatting.                                                                                                             |
| pnpm lint                                                    | PASS; zero warnings.                                                                                                                                    |
| pnpm typecheck                                               | PASS.                                                                                                                                                   |
| pnpm test                                                    | PASS; 46 Vitest cases plus 1 Node toolchain test = 47.                                                                                                  |
| pnpm build                                                   | PASS; 7 build tasks.                                                                                                                                    |
| pnpm check                                                   | PASS in ordinary configuration; also PASS uncached with TURBO_FORCE=true and TURBO_CONCURRENCY=1. Initial forced parallel run failed as detailed below. |
| pnpm test:integration                                        | PASS; 35 database cases (26 new + 9 foundation), 8 Redis cases, zero skipped; both upgraded and fresh databases.                                        |
| pnpm smoke                                                   | PASS; 16 assertions with PostgreSQL and Redis reachable.                                                                                                |
| pnpm mobile:check                                            | PASS; dependencies up to date.                                                                                                                          |
| pnpm mobile:export                                           | PASS; Android export. Native device/store builds not run.                                                                                               |
| Fresh migration deploy/status/diff/redeploy                  | PASS; all 3 migrations replayed; no pending migrations; empty Prisma schema diff; second deploy was a no-op.                                            |
| pnpm audit --audit-level=high                                | EXPECTED FAIL, exit 1; exactly 2 high: node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm; no new advisories.                                |
| git diff --check                                             | PASS.                                                                                                                                                   |
| Accepted migrations/dependencies/CI/safety guards comparison | PASS; unchanged against a4448fa.                                                                                                                        |

Fresh database tsms_stage21_1791408571535_test was verified absent before creation. The harness derived its connection
from the explicit TEST_DATABASE_URL, validated loopback and the _test suffix with the existing guard,
then used the existing migrate-test script and full integration command. All three migrations applied,
all 43 integration tests passed, migrate status was current, and schema diff exited 0. Only this
run-owned fresh database was removed afterward. The application database, volumes, and unrelated Docker
resources were untouched. The usual tsms_test database now has the new migration. Existing services
were already healthy before work and remain running.

### Failures investigated and validation limits

- Migration-diff generation initially rejected a BOM introduced by PowerShell into a gitignored baseline
  schema copy. Removing the BOM fixed generation; no database was changed by that failed command.
- The first integration run had four assertion failures because Prisma 7 exposes PostgreSQL SQLSTATE
  under meta.driverAdapterError.cause.originalCode. The actual database constraints already rejected
  the invalid rows. Assertions were corrected to that observed structure; all 43 cases then passed.
- The first fresh-database harness loaded NODE_ENV=development from .env into a full command containing
  Next builds. Migration replay and all 35 database cases passed, but Next prerendering failed. The
  temporary harness now uses NODE_ENV=production for builds; test setup still pins test mode. Fresh
  replay/full integration then passed. No application or committed configuration change was needed.
- Forced parallel pnpm check exposed concurrent prisma generate in the existing database build/typecheck scripts (EEXIST on generated/prisma/internal). An uncached serial check and the ordinary default check passed. Task configuration is unchanged; coordinate generation in a separately authorized tooling follow-up.
- Sandboxed Expo dependency checking failed with EACCES, and the sandboxed audit retry failed with a
  socket-permission error. Network-enabled reruns passed mobile checking and returned exactly the
  expected two-high audit baseline. Neither network failure was treated as an advisory result. Final Docker status inspection also
  required a network-enabled tool run after sandbox named-pipe access was denied; both services were healthy.
- Git reported a non-blocking permission warning for its global ignore file. Optional process inspection
  through Get-CimInstance was denied; validation command exits/logs supplied the required evidence.
- Native device/store builds and non-amd64 images were not run. Hosted verification is recorded below.

## Security review

Reviewed the complete tracked diff and all new files. Six new tables, two enums, five restrictive foreign
keys, and no DROP/TRUNCATE/CASCADE in the migration. User has no school, tenant, role, permission, class,
student, teacher, or organization attributes. No plaintext/reversible password field, raw token field,
public registration, auth endpoint, hashing service, middleware, UI, JWT/auth dependency, or real secret
was introduced. Hash fixtures are inert and synthetic. No arbitrary event metadata/request dump column.

Both accepted migrations and their lock file, all application files, dependency manifests/lockfile,
environment configuration, test guards, CI workflow, and Turbo configuration match the starting baseline.
Stage 1 acceptance, validation, and security dispositions were preserved and compared with baseline state;
the historical CI handoff was archived verbatim. Audit policy remains unchanged and still fails openly.

Standing follow-ups: the recorded generation race; unresolved Stage 0 advisories; scoped Prisma overrides;
Actions declaring Node 20 while running on Node 24; ubuntu-latest migration from 24.04 to 26.04.

## Changed files and handoff

- PROJECT_STATE.md
- project-state.json
- tasks/CURRENT.md
- tasks/ROADMAP.md
- docs/architecture/DATABASE.md
- packages/database/prisma/schema.prisma
- packages/database/prisma/migrations/20261007210000_identity_schema/migration.sql
- packages/database/tests/database.integration.test.mjs
- packages/database/tests/identity.integration.test.mjs
- tasks/completed/stage-1-hosted-ci-repair.md

## Owner acceptance and commit authorization

The owner accepted Stage 2.1 locally, subject to hosted CI verification, and authorized committing all ten
reviewed files with subject `feat: add authentication identity schema`, then pushing main to origin.
No amend, force push, deployment, or Stage 2.2 work is authorized.

All eight final boundary checks passed: exactly the ten listed files; accepted migrations unchanged;
no tenantId/schoolId/role/permissions on User; hash-only credential/token columns; no authentication
behavior/endpoints/middleware/registration/JWT/membership/RBAC; unchanged pnpm-lock.yaml; clean
`git diff --check`; both existing advisories documented and a fresh audit showing exactly those two high
findings and no new advisories. Schema, SQL, tests, and all changed/new files were reviewed.

At commit preparation the seven modified and three new files are the complete reviewed scope. Generated
output and local evidence remain gitignored. Hosted verification was pending at preparation; completed results are recorded below.

Exact next action: hard stop after this documentation closure commit and normal push. Stage 1 remains ACCEPTED. Stage 2.1 is ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 is NOT accepted.
Stage 2.2 has NOT started and remains NOT authorized. No tenant or RBAC functionality exists.

**DO NOT start Stage 2.2 without explicit owner authorization.** No later authentication behavior,
dependencies, endpoints, middleware, UI, tenant/RBAC work, audit weakening, accepted migration rewrites,
amendment of accepted commits, force push, or deployment.

## Completed hosted verification - 2026-10-07

Commit `61331fb2c02c3846b92343f50289bbd4e604a1be` (`feat: add authentication identity schema`) was pushed successfully from main to origin without force. All eight final boundary checks passed before commit; exactly the ten reviewed files were committed. Accepted migrations and pnpm-lock.yaml remain unchanged.

[GitHub Actions run 37692526719](https://github.com/ubaliringim/tsms/actions/runs/37692526719) completed for that exact commit. `validate` PASS: 47 unit/toolchain tests, 43 integration tests (35 database including 26 new identity tests, plus 8 Redis), and 16 smoke assertions. Frozen install, Prisma generation, check, mobile dependency check/export, and clean tracked-file verification passed. All three migrations applied on hosted Ubuntu 24.04.

`security-audit` FAIL EXPECTED: exactly two high advisories, node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. No new high advisory or suppression. There are no other jobs. The overall workflow is red solely because of this accepted audit baseline. Both the Actions Node 20-to-24 runtime warning and Ubuntu 24.04-to-26.04 migration notice still appear and remain follow-ups. Concurrent Prisma generation EEXIST was not observed on this run; the existing tooling follow-up remains open. All prior documented follow-ups and security dispositions remain unchanged.

Evidence: gh run watch completed with exit 1 for the expected audit failure; gh run view JSON and logs confirmed both jobs and test counts. Local ignored evidence is in artifacts/stage21/hosted-result.json and hosted-run.log. The working tree was clean immediately after push, with local HEAD and origin/main both at the commit above. The owner subsequently authorized this documentation closure checkpoint, limited to PROJECT_STATE.md, project-state.json, and tasks/CURRENT.md, with commit subject `docs: close Stage 2.1 hosted validation` and a normal push. No implementation changes or amendment are authorized.

Stage 1 remains ACCEPTED. Stage 2.1 is OWNER ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 as a whole is NOT accepted. Stage 2.2 has NOT started and remains unauthorized. No deployment, tenant membership, or RBAC work occurred. **Do not start Stage 2.2 without explicit owner authorization.**

Owner closure decision (2026-10-07): Stage 2.1 is ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 1 remains ACCEPTED; Stage 2 overall remains NOT ACCEPTED. Stage 2.2 is NOT STARTED / UNAUTHORIZED. Closure scope is only these three state files; all known follow-ups remain open. Validate formatting, JSON state consistency and preserved follow-ups, the exact three-file diff, and `git diff --check` before committing. Verify branch synchronization and clean status after the normal push.

Documentation closure validation: pnpm format:check PASS; JSON state consistency and exact three-file scope assertions PASS; prior knownIssues, security dispositions, scoped overrides, audit policy, and Stage 1 records unchanged; git diff --check PASS. No application regression suite was rerun for this documentation-only checkpoint.
