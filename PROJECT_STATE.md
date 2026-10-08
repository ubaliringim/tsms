# TSMS project state

Project: TSMS - TeamStack School Management System

Company: TeamStack Technologies LTD

Updated: 2026-10-08

Phase: Foundation

Stage: 2 - Authentication & Identity

Stage status: AUTHORIZED, not accepted. Owner approved Specification v1.0.

Stage 1 status: ACCEPTED by the project owner on 2026-10-07.

Stage 0 status: ACCEPTED (owner decision, 2026-10-07). Record at tasks/completed/stage-0-engineering-foundation.md.

Next substage: 2.6 - Rate limiting and abuse protection. NOT STARTED / UNAUTHORIZED.

Accepted capabilities: PostgreSQL local infrastructure, Redis local infrastructure, pgvector extension foundation, Prisma 7 database foundation, packages/database, packages/redis, migration workflow, database and Redis lifecycle handling, API and worker liveness/readiness separation, integration-test infrastructure, test-database safety controls, Docker Compose workflow, fresh-state reproducibility, the Stage 1 CI workflow, the three Prisma dependency security remediations, the temporary InfrastructureProbe scaffolding, and the smoke-test readiness extensions. The Stage 1 known issues were reviewed and accepted as non-blocking.

Security: Two open high-severity dependency advisories from Stage 0 (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm) retain owner-approved temporary dispositions based on documented non-reachability. Both remain UNRESOLVED: both packages are still installed, both vulnerable code paths are still present on disk, and neither has a patched upstream release. Stage 1 introduced three further advisories through Prisma (deepmerge-ts, mysql2 twice); all three had patched releases and were REMEDIATED via scoped overrides, not accepted. The overrides are scoped to their introducing Prisma parent ('@prisma/config>deepmerge-ts' and 'prisma>mysql2'), and the pre-override versions were proven unreachable and removed from disk; the installed graph was re-confirmed at Stage 1 acceptance. See docs/security/DEPENDENCY_RISK_REGISTER.md.

Audit status: `pnpm audit --audit-level=high` still FAILS with two high findings, unchanged from the Stage 0 baseline. No advisory is suppressed, no threshold is lowered, no broad ignore rule exists, and no security-exception framework has been introduced. In CI the raw audit runs in a dedicated security-audit job so a functional regression and the known security-policy gate are separately attributable. That job still fails, so the workflow still reports red.

Historical Stage 1 acceptance validation: Frozen install, format, lint, typecheck, 47 unit tests, builds, 17 Docker-requiring integration tests, 16 smoke assertions (both with infrastructure up and with it stopped), mobile dependency check, mobile Android export, Prisma validate/generate/format-check/migrate status, fresh-database migration, volume persistence, a forced no-cache build from a fresh checkout, and a full fresh-state infrastructure rebuild. `pnpm audit --audit-level=high` fails as expected.

Post-acceptance hosted CI repair (2026-10-07): Stage 1 was committed and pushed as `635536b`. Its first hosted Linux run failed unexpectedly in integration setup, while the separate raw security audit failed as expected. The workflow already declares valid disposable test URLs, but Turbo strict mode filtered both out because the integration task did not declare them. Local `.env` loading masked the defect. Reproduction without `.env` confirmed migration succeeds outside Turbo, then Vitest fails with `Invalid environment configuration: TEST_DATABASE_URL, TEST_REDIS_URL`. The repair adds only those two names to `tasks.test:integration.env` in `turbo.json`; strict mode, configuration validation, safety guards, migrations, and workflow audit behavior are unchanged. Stage 1 remains ACCEPTED. Repair validation and follow-up warnings are recorded in `tasks/completed/stage-1-hosted-ci-repair.md`; repair commit `ceffd2e` is now owner-verified on hosted Linux GitHub Actions: `validate` PASS, `security-audit` FAIL as expected on exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. Hosted verification is complete and the repair is CLOSED; the overall workflow remains red because of the unsuppressed audit.

Closure validation (2026-10-07) found and fixed two real Stage 1 defects before acceptance: a fresh checkout could not build because Prisma Client generation was not part of the database package build, and `pnpm infra:up` returned a non-zero exit code because Compose treats the one-shot test-database init container as a failure. Both were fixed and re-verified.

Stage 2.1 implementation: six global identity persistence models, native UUID columns with Prisma UUIDv7 defaults, unique normalized email and hash fields, one credential per user, explicit restrictive foreign keys, lifecycle timestamps, and a new forward migration. InfrastructureProbe is retained for independent Stage 1 regression tests. No accepted migration is changed. Validation passed: 47 unit/toolchain tests, 43 integration tests (26 new), 16 smoke assertions, builds, mobile dependency check/export, and a fresh three-migration replay with no schema drift. The audit still fails on exactly the known two high advisories. See tasks/CURRENT.md for commands, outcomes, and limitations.

Not implemented: HTTP authentication behavior, login/logout, session HTTP transport/cookies/middleware, token generation or consumption, recovery/email delivery, UI, tenants, memberships, roles, permissions, or other product functionality. Stage 2.2 adds only the Argon2 password dependency.

Version-control handoff: owner authorized committing the ten reviewed Stage 2.1/state files as `feat: add authentication identity schema` and pushing main to origin after all eight boundary checks pass. All eight passed, including a refreshed audit with exactly the two known high advisories. Hosted verification was pending at commit preparation; the completed result is recorded below.

Validation limitation: forced parallel checking exposed concurrent Prisma generation in the existing build/typecheck scripts (EEXIST). The uncached serial check and ordinary default check passed; task configuration is unchanged. Track coordinated generation as a separate tooling follow-up. Hosted Stage 2.1 validate passed; native device/store builds have not run.

Stage 2.3 status: ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Handoff record: tasks/CURRENT.md. No Stage 2.3 archive file has been created; only the four authorized documentation files changed in that closure.

Stage 2.4 status: ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Implementation commit `891af278313f68f385dbf6e405f9304347bb82bd` (`feat: add HTTP authentication endpoints`); hosted run [37747657210](https://github.com/ubaliringim/tsms/actions/runs/37747657210). Record at tasks/CURRENT.md and docs/security/AUTH_API.md.

Stage 2.5 status: IN PROGRESS / LOCALLY VALIDATED; NOT ACCEPTED, not committed, not pushed, not deployed. Current substage. Record at tasks/CURRENT.md and docs/security/PASSWORD_RECOVERY.md.

Next substage: 2.6 - Rate limiting and abuse protection. NOT STARTED / UNAUTHORIZED.

Exact next action: owner reviews the Stage 2.5 implementation, the atomicity design, and the escalated session-creation race decision. Changes remain uncommitted.

DO NOT: start Stage 2.6 or later, deploy to any public network, add a real email provider, add a session-generation column, add registration/email-verification/MFA, change accepted schema/migrations, weaken audits, commit, push, or deploy without explicit authorization.

Current evidence and handoff: tasks/CURRENT.md. Historical Stage 1 acceptance: tasks/completed/stage-1-database-and-local-infrastructure.md. Security dispositions, owner decisions, and audit policy: docs/security/DEPENDENCY_RISK_REGISTER.md. Database and infrastructure implementation: docs/architecture/DATABASE.md and infrastructure/README.md. Toolchain compatibility: docs/architecture/DEPENDENCY_REVIEW.md.

## Completed hosted verification - 2026-10-07

Commit `61331fb2c02c3846b92343f50289bbd4e604a1be` (`feat: add authentication identity schema`) was pushed successfully from main to origin without force. All eight final boundary checks passed before commit; exactly the ten reviewed files were committed. Accepted migrations and pnpm-lock.yaml remain unchanged.

[GitHub Actions run 37692526719](https://github.com/ubaliringim/tsms/actions/runs/37692526719) completed for that exact commit. `validate` PASS: 47 unit/toolchain tests, 43 integration tests (35 database including 26 new identity tests, plus 8 Redis), and 16 smoke assertions. Frozen install, Prisma generation, check, mobile dependency check/export, and clean tracked-file verification passed. All three migrations applied on hosted Ubuntu 24.04.

`security-audit` FAIL EXPECTED: exactly two high advisories, node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. No new high advisory or suppression. There are no other jobs. The overall workflow is red solely because of this accepted audit baseline. Both the Actions Node 20-to-24 runtime warning and Ubuntu 24.04-to-26.04 migration notice still appear and remain follow-ups. Concurrent Prisma generation EEXIST was not observed on this run; the existing tooling follow-up remains open. All prior documented follow-ups and security dispositions remain unchanged.

Evidence: gh run watch completed with exit 1 for the expected audit failure; gh run view JSON and logs confirmed both jobs and test counts. Local ignored evidence is in artifacts/stage21/hosted-result.json and hosted-run.log. The working tree was clean immediately after push, with local HEAD and origin/main both at the commit above. The owner subsequently authorized this documentation closure checkpoint, limited to PROJECT_STATE.md, project-state.json, and tasks/CURRENT.md, with commit subject `docs: close Stage 2.1 hosted validation` and a normal push. No implementation changes or amendment are authorized.

Stage 1 remains ACCEPTED. Stage 2.1 is OWNER ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 as a whole is NOT accepted. Stage 2.2 is now separately authorized; Stage 2.3 is NOT STARTED / UNAUTHORIZED. No deployment, tenant membership, or RBAC work occurred. **Do not start Stage 2.3 without explicit owner authorization.**

Historical Stage 2.1 closure remains unchanged; see tasks/completed/stage-2-1-identity.md. Stage 2.2 authorization supersedes the earlier hard stop for 2.2 only.

Stage 2.2 local validation (2026-10-08): internal password policy, Argon2id hashing/verification/rehash detection, and Prisma credential creation/replacement are implemented. Policy is 15-128 Unicode code points without transformation. Argon2id uses 65536 KiB, three iterations, one lane, and 32-byte output. Frozen install, generation, formatting, lint, typecheck, 62 unit/toolchain tests, 51 integration tests, seven build tasks, aggregate check, 16 smoke assertions, mobile check/export, and diff check passed. Existing Turbo caches were used where applicable; focused Stage 2.2 tests ran separately (15 unit, eight integration). Audits before/after installation and at completion report exactly the two accepted high advisories. No migration or HTTP/session/tenant/RBAC functionality was introduced. All changes remain uncommitted for owner review; hosted Stage 2.2 validation has not run. See docs/security/PASSWORD_CREDENTIALS.md and tasks/CURRENT.md.

## Final review and commit authorization

The owner authorized repairing the two archived Markdown links, final validation, committing the reviewed Stage 2.2 files as `feat: add password credential service`, and pushing main normally if all checks pass. Both link targets exist and all relative Markdown links in changed documentation/state files resolve. Production Argon2 costs are unchanged and frozen; additional malformed/excessive-cost probes passed without emitting credential material. No schema, migration, logging, HTTP authentication, or tenant/RBAC expansion. The refreshed audit contains only the two accepted high advisories. This authorization supersedes the earlier uncommitted-review checkpoint instructions above. Record actual hosted results afterward and leave those state updates uncommitted; no second documentation commit, amendment, force push, deployment, or Stage 2.3 work is authorized.

## Stage 2.2 hosted verification complete - 2026-10-08

Implementation commit `cdf0ecd62565e9f1a0c0b701263e36c2e9092920` (`feat: add password credential service`) was pushed normally to origin/main. Exactly 17 reviewed files were committed, including the two repaired archive links. No amendment, force push, deployment, or second documentation commit.

[Hosted run 37725238380](https://github.com/ubaliringim/tsms/actions/runs/37725238380) completed for this exact SHA. `validate` PASS (1m38s): 62 unit/toolchain tests, 51 integration tests (35 database, eight Redis, eight credential), 16 smoke assertions; production Argon2id tests and Linux native installation PASS, Prisma generation and migration replay PASS, mobile check/export PASS, tracked-file cleanliness PASS. `security-audit` EXPECTED FAIL (24s), exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm, both high. No new advisory, suppression, or resolution. No other jobs. Overall workflow failure is solely the expected audit gate. Node 20-to-24 and Ubuntu migration notices remain. The concurrent Prisma generation follow-up remains open.

Evidence: gh run view job JSON and complete logs (ignored artifacts/stage22/hosted-run.log). Working tree was clean after pushing, and local HEAD/origin/main matched the implementation SHA. This post-run handoff updates PROJECT_STATE.md, project-state.json, tasks/CURRENT.md, and docs/security/PASSWORD_CREDENTIALS.md only; the owner has now accepted Stage 2.2 and authorized this documentation closure commit. These completed results supersede the earlier pending/uncommitted implementation checkpoint above. Hosted Linux verification is now complete; future target portability and existing infrastructure/toolchain/native/store follow-ups remain.

Stage 1 remains ACCEPTED; Stage 2.1 remains ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2 is ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Stage 2 overall is NOT ACCEPTED. Exact next action: hard stop after this authorized documentation closure commit and normal push. **HARD STOP: Stage 2.3 is NOT STARTED / UNAUTHORIZED. Do not begin Stage 2.3 or deploy.**

Final documentation closure: the owner accepted Stage 2.2 and authorized committing only PROJECT_STATE.md, project-state.json, tasks/CURRENT.md, and docs/security/PASSWORD_CREDENTIALS.md with subject `docs: close Stage 2.2 hosted validation`, then pushing main normally. This supersedes the earlier pending-review/no-documentation-commit checkpoint above. All implementation, hosted evidence, unresolved advisories, and existing follow-ups remain unchanged. Stage 1 ACCEPTED; Stage 2.1 and 2.2 ACCEPTED / HOSTED VERIFIED / CLOSED; Stage 2 overall NOT ACCEPTED; Stage 2.3 NOT STARTED / UNAUTHORIZED. Validate formatting, state consistency and diff before commit; verify synchronization and clean working tree after push.

## Current authorization - Stage 2.3

The owner separately authorized Secure Session Foundation only. Earlier Stage 2.2 checkpoints above are historical; their Stage 2.3 prohibition is superseded only by this explicit authorization. Stage 2.1 and 2.2 remain CLOSED. Stage 2 overall NOT ACCEPTED. Stage 2.4 NOT STARTED / UNAUTHORIZED. Current handoff: tasks/CURRENT.md; preserved Stage 2.2 handoff: tasks/completed/stage-2-2-password-credentials.md. No commit/push/deploy is authorized for this task.

Stage 2.3 local validation: 32-byte CSPRNG tokens, SHA-256 digest persistence, fixed seven-day expiry, current-user validation, ownership-enforced revocation and revoke-all are implemented as internal primitives. lastSeenAt remains unchanged. Creation/disable/revoke-all race limits are documented in docs/security/SESSIONS.md and tested. All requested local checks passed: 74 unit/toolchain tests, 68 integration tests, 16 smoke assertions, builds, mobile check/export, formatting and diff checks; audit remains expected failure on exactly the two accepted high advisories. No new dependency, schema/migration, endpoint, cookie/JWT, tenant/RBAC or safety-guard change. Stage 2.3 is ready for owner review only, not accepted; hosted verification has not run. Exact next action: owner reviews Stage 2.3 implementation and security results. HARD STOP: no Stage 2.4, commit, push, or deployment without explicit authorization.

## Stage 2.3 hosted verification complete - 2026-10-08

Implementation commit `c75361e85e5315b8eb17646da2825cfd9eea7b91` (`feat: add secure session foundation`) was pushed normally from main to origin. No amendment, force push, or deployment. The baseline `333ee77` remains an ancestor and was not rewritten.

[Hosted run 37733953331](https://github.com/ubaliringim/tsms/actions/runs/37733953331) completed for this exact SHA.

`validate` **PASS** (1m38s): frozen install, Prisma generation, Compose infrastructure, `pnpm check`, integration tests, mobile dependency check, mobile Android export, smoke, teardown, and tracked-file cleanliness all passed. Hosted Linux counts match local exactly: 73 Vitest unit tests plus one Node toolchain test (74 total; API 36), 68 integration tests (35 database, eight Redis, 25 API), 16 smoke assertions, and all three migrations replayed on hosted Ubuntu. Native argon2 installation and Linux service startup passed.

`security-audit` **EXPECTED FAIL** (23s): exactly two high advisories, `node-forge` GHSA-86w9-cpqp-85rv and `braces` GHSA-vfj7-8cjw-p6xm, both `Patched versions: None`. No new advisory, no suppression, no resolution, threshold unchanged. No other jobs. The overall workflow is red solely because of this accepted audit baseline.

Follow-ups persist: the Actions Node 20-to-24 runtime warning (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`), the ubuntu-latest to Ubuntu 26 migration notice, and the concurrent Prisma generation EEXIST item. The workflow display name is still `Stage 1 validation`; renaming it is cosmetic and left unchanged here.

Stage 2.3 is now ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Acceptance does not resolve any dependency advisory: both dispositions above remain UNRESOLVED and both packages remain installed. Stage 0, Stage 1, Stage 2.1 and Stage 2.2 acceptance are untouched. Stage 2 overall remains NOT ACCEPTED. Stage 2.4 remains NOT STARTED / UNAUTHORIZED.

## Stage 2.3 final documentation closure - 2026-10-08

The owner accepted Stage 2.3 and authorized committing only `PROJECT_STATE.md`, `project-state.json`, `tasks/CURRENT.md`, and `docs/security/DEPENDENCY_RISK_REGISTER.md` with subject `docs: close Stage 2.3 hosted validation`, then pushing main normally. Before that commit, the pending-change set was confirmed to be exactly those four files: no implementation, test, schema, migration, dependency, lockfile, configuration, or CI file was modified, and the working tree held no untracked files. Both `HEAD` and `origin/main` equalled the accepted implementation SHA `c75361e85e5315b8eb17646da2825cfd9eea7b91`.

Recorded hosted results, unchanged from the verification section above: `validate` PASS; 74 unit/toolchain tests; 68 integration tests; 16 smoke assertions; Prisma migration replay PASS with all three accepted migrations applied; mobile dependency check and Android export PASS; `security-audit` EXPECTED FAIL on exactly the two documented high-severity advisories. The overall workflow remains red and is **not** marked green. Neither advisory is marked resolved. All prior stage history, security dispositions, and known follow-ups are preserved: the two high advisories, the two scoped Prisma overrides, the concurrent Prisma generation EEXIST item, the Actions Node 20-to-24 runtime warning, the ubuntu-latest to Ubuntu 26 migration notice, native Android/iOS device and store builds not having run, non-amd64 image verification, the Compose PostgreSQL major-version tag pin, development-only local credentials, the deferred security-audit exception mechanism, InfrastructureProbe retirement through a future forward migration, and the Stage 2.2 portability, capacity, and policy-evolution reviews.

Acceptance is bounded to the Stage 2.3 session primitives as implemented. The documented create/disable and revoke-all races, the in-flight validation caveat, and the disable/re-enable semantics remain open limitations, and the coordinated atomic sign-out-everywhere workflow, optional session-generation schema extension, and administrative revocation workflow remain deferred to separately authorized future work.

Stage 0: ACCEPTED. Stage 1: ACCEPTED. Stage 2.1: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.3: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 overall: NOT ACCEPTED. Stage 2.4: NOT STARTED / UNAUTHORIZED. **HARD STOP.**

Takeover review (2026-10-08) started from 333ee77, equal to origin/main with a clean tree, and revalidated every previous-agent claim rather than trusting it. All confirmed: focused suites, regression suites, smoke, mobile, and the unchanged two-high audit baseline. Three in-scope corrections were made, with no production code, schema, migration, dependency, or safety-guard change: an inaccurate claim about the UUID length check was corrected (it is redundant defence-in-depth; the anchored regex already rejects trailing line terminators, verified empirically against the compiled service); a unit test now pins the rejected identifier shapes across all four JavaScript line terminators and asserts a genuine UUID reaches the database; an integration test now covers the documented disable/re-enable behaviour, which previously had no coverage; and tasks/completed/README.md was updated to index the hosted CI repair, Stage 2.1, and the newly archived Stage 2.2 handoff, and to state that Stage 2 as a whole is not accepted. Stage 0, Stage 1, Stage 2.1 and Stage 2.2 acceptance are untouched. All work remains uncommitted; nothing staged, pushed, or deployed.

## Stage 2.4 login, current user and logout API - 2026-10-08

The owner authorized Stage 2.4 only. Three endpoints now adapt the accepted Stage 2.2 password and
Stage 2.3 session primitives to HTTP: `POST /auth/login`, `GET /auth/me`, and `POST /auth/logout`.
The accepted contract is docs/security/AUTH_API.md. This adds no authorization: there is still no
tenant, school, membership, role, or permission concept, and no route reads any of them.

Implementation, in `apps/api/src/identity/`: `auth.service.ts` orders the operations and holds the
failure taxonomy; `auth.controller.ts` is HTTP transport only; `auth-cookie.ts` derives and parses
the browser cookie; `trusted-origin.guard.ts` is the CSRF admission check; `auth-body-limit.ts` and
`auth-exception.filter.ts` bound and sanitise input. `api_TRUSTED_ORIGINS` is a new required,
startup-validated configuration value, added to the config package, turbo `globalEnv`, `.env.example`,
CI, and the smoke script.

Security posture: the opaque token appears only in a `Set-Cookie` header, never in a body, URL, or
log; the cookie is `HttpOnly` and `SameSite=Lax` always, `__Host-` and `Secure` in production with
no configuration able to disable that, and `Path=/` with no `Domain` in every environment; a
duplicated session cookie is rejected rather than resolved; login and logout require an exact
`Origin` match with no `Host` or forwarded-header fallback and fail closed when it is absent;
credentialed CORS is not enabled; and every authentication response including errors is `no-store`
with `Vary: Origin`.

All four authentication-failure conditions return one indistinguishable body, and each still pays
the production Argon2id cost against a committed decoy digest so a single request cannot reveal
which condition occurred. This is explicitly not a claim of constant-time HTTP authentication.

**Rate limiting is absent and is the largest gap in this stage.** Password verification is
reachable over HTTP with no throttling, so Stage 2.4 must not be exposed directly to the public
internet. Stage 2.6 owns full rate limiting and abuse protection.

Local validation passed with no dependency, lockfile, schema, migration, or accepted-document change:
frozen install, Prisma generation, formatting, lint, typecheck across 11 tasks, 112 unit/toolchain
tests (config 22, Redis 4, database 8, worker 4, API 73 including 37 focused, plus one Node toolchain
test), builds across 7 tasks, the aggregate check, 134 integration tests (API 91), 19 smoke
assertions, mobile dependency check, Android export, and `git diff --check`. `pnpm audit
--audit-level=high` still fails on exactly the two accepted high advisories with no new finding.

Four defects were found and fixed during review rather than left for the owner: a `URL` parse gap
that silently accepted a wildcard host into the origin allowlist; an exception filter that matched a
body-parser error `type` Nest discards before filters run, which let a malformed-JSON parser message
reach the client; an unreliable adapter-derived 413, replaced with an explicit pre-parse
`Content-Length` check; and an unused import and lint suppression cleaned up.

Changes are uncommitted, unstaged, and unpushed. **HARD STOP: Stage 2.5 is NOT STARTED /
UNAUTHORIZED.**

## Stage 2.4 security review, commit and hosted verification - 2026-10-08

The owner conditionally accepted Stage 2.4 for implementation commit and hosted verification. An
independent security review was performed before committing, driving the real application against
real PostgreSQL rather than relying on the committed tests.

Enumeration resistance was verified by comparing the complete observable response - status, every
header, and body - for unknown email, wrong password, missing credential, disabled account, and
policy-invalid passwords against both an existing and an unknown account. All six were byte-identical:
`401` with `{"statusCode":401,"error":"authentication_failed"}`, `Cache-Control: no-store`,
`Vary: Origin`, no `Set-Cookie`. No session row was written on any failure path, and no password,
digest, address, Prisma code, or stack reached the client. The committed decoy Argon2id digest was
confirmed to execute: a failed login with a policy-valid password measured 324 ms against 348 ms for a
real successful verification. This remains an explicit **non-constant-time** claim.

Session security was verified directly: exactly one session per successful login; the token appears
only in `Set-Cookie` and is absent from the body, from every other header, and from the request URL;
PostgreSQL holds only the SHA-256 digest and no column contains the raw token; `HttpOnly` and
`SameSite=Lax` in both environments with `__Host-` and `Secure` in production and no configuration
able to disable it; no `Domain`; measured lifetime exactly 604800000 ms with cookie `Max-Age` matching;
duplicate cookies fail closed; logout revokes only the presented session, preserves the original
revocation timestamp on repeat, leaves the same user's other session and other users' sessions valid,
and clears the cookie with matching attributes; revoked, expired and disabled sessions are all
rejected by `GET /auth/me`; and every authentication response including errors is `no-store`.

Origin enforcement rejected all ten disallowed forms with 403, covering scheme, port and host
differences, a suffix lookalike, a wildcard, a trailing slash, and four spoofed forwarded, `Host` and
`Referer` headers. Query-supplied credentials and tokens are ignored: a logout driven by `?token=`
does not revoke anything, and `/auth/me` cannot be driven by a query token. No credentialed CORS
header is emitted, and the authentication path contains no `console`, `Logger`, `stdout` or `stderr`
write at all.

Two defects were corrected during the review, both in test and state bookkeeping rather than product
behaviour. The recorded unit/toolchain total was wrong: the correct figure is **112**, not the 109
recorded in the previous checkpoint, because that figure omitted three pre-existing API unit tests. The
74-test Stage 2.3 baseline plus 38 tests added by Stage 2.4 gives 112. Separately, seven integration
assertions counted session rows globally, so unrelated residue in the disposable test database failed
27 tests; those assertions are now scoped to each test's own fixture users and were re-verified by
seeding a foreign row and confirming the suite still passes. The residue was then removed.

The 23 reviewed Stage 2.4 files were committed as `891af278313f68f385dbf6e405f9304347bb82bd` with
subject `feat: add HTTP authentication endpoints` and pushed normally. No amendment, force push, or
deployment. The baseline `6df160a` remains an ancestor. No dependency, lockfile, schema, migration, or
accepted-stage document changed.

[Hosted run 37747657210](https://github.com/ubaliringim/tsms/actions/runs/37747657210) completed for
that exact SHA. `validate` **PASS** (1m35s) with every step green: 112 unit/toolchain tests, 134
integration tests, 19 smoke assertions, all three migrations replayed, mobile dependency check and
Android export at 578 modules, and tracked-file cleanliness. Hosted counts match local exactly.
`security-audit` **EXPECTED FAIL** (25s) on exactly node-forge GHSA-86w9-cpqp-85rv and braces
GHSA-vfj7-8cjw-p6xm, both high, both with no patched release, no new advisory and no suppression. No
other jobs. **The overall workflow is red and is not green.** The Actions Node 20-to-24 warning and the
Ubuntu migration notice persist unchanged; concurrent Prisma generation was not observed on this run and
that follow-up remains open.

Stage 2.4 reached HOSTED VERIFIED / AWAITING FINAL OWNER ACCEPTANCE at this checkpoint; the owner accepted it immediately afterwards. See the final documentation closure section below. Stage 0, Stage 1, Stages 2.1, 2.2 and 2.3 acceptance are untouched. Stage 2 overall remains NOT ACCEPTED. Stage 2.5 remains NOT STARTED / UNAUTHORIZED. No deployment occurred.

## Stage 2.4 final documentation closure - 2026-10-08

The owner accepted Stage 2.4 and authorized committing only PROJECT_STATE.md, project-state.json and
tasks/CURRENT.md with subject `docs: close Stage 2.4 hosted validation`, then pushing main normally.
Before that commit the working tree was confirmed to hold exactly those three modified documentation
files, with nothing staged, nothing untracked, and no implementation, test, schema, migration,
dependency, lockfile, configuration, or CI file touched. Both HEAD and `origin/main` equalled the
accepted implementation SHA `891af278313f68f385dbf6e405f9304347bb82bd`.

Recorded hosted results, unchanged from the verification checkpoint: `validate` PASS; 112
unit/toolchain tests; 134 integration tests; 19 smoke assertions; Prisma migration replay PASS with
all three accepted migrations applied; mobile dependency check and Android export PASS at 578
modules; `security-audit` EXPECTED FAIL on exactly the two documented high-severity advisories. The
overall workflow remains red and is **not** green. Neither advisory is marked resolved.

Acceptance is bounded to global identity authentication as implemented. The following stay explicitly
open and are not resolved by this acceptance:

- **No login rate limiting.** Password verification is reachable over HTTP without throttling. Public
  internet deployment is prohibited until Stage 2.6 delivers abuse protection.
- The trusted `Origin` allowlist is not proxy-aware; a TLS-terminating proxy must preserve the
  browser-supplied `Origin`.
- A session-bound CSRF token for future authenticated mutations remains deferred.
- Rehash-on-login is not implemented; Argon2id parameter evolution remains an explicit follow-up.
- Credentialed CORS for the web and control applications is not implemented, so that contract is
  same-origin only.
- `AuthenticationEvent` recording is not implemented.
- The accepted Stage 2.3 session concurrency limitations remain documented and unchanged.
- `node-forge` GHSA-86w9-cpqp-85rv and `braces` GHSA-vfj7-8cjw-p6xm remain **unresolved**, with no
  patched upstream release.

All previously documented infrastructure, Prisma, native-platform, CI, and dependency follow-ups are
preserved unchanged: the concurrent Prisma generation EEXIST item, the Actions Node 20-to-24 runtime
warning, the ubuntu-latest to Ubuntu 26 migration notice, native Android/iOS device and store builds
not run, non-amd64 image verification, the Compose PostgreSQL major-version tag pin, development-only
local credentials, the deferred security-audit exception mechanism, InfrastructureProbe retirement
through a future forward migration, and the Stage 2.2 portability, capacity, and policy-evolution
reviews.

Stage 0: ACCEPTED. Stage 1: ACCEPTED. Stage 2.1: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2:
ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.3: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.4:
ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 overall: NOT ACCEPTED. Stage 2.5: NOT STARTED /
UNAUTHORIZED. **HARD STOP.**

## Stage 2.5 secure password recovery - 2026-10-08

The owner authorized Stage 2.5 only. Two endpoints now recover access for an existing global user:
`POST /auth/password/forgot` and `POST /auth/password/reset`. The accepted contract is
docs/security/PASSWORD_RECOVERY.md. No registration, no tenant or school concept, no authorization,
and no session is issued by recovery.

The accepted `PasswordResetToken` model already carried `userId`, unique `tokenHash`, `expiresAt`,
`usedAt`, and `createdAt`, which satisfies digest-only storage, a fixed lifetime, single use, and
supersession. **No schema change and no migration were added or modified.** Tokens are 32 random
bytes, canonical 43-character base64url, stored as a SHA-256 digest, expiring after a fixed 30
minutes with no extension. The reset link carries the token in the URL fragment, never the query
string, so it cannot reach a server access log or a `Referer`.

Atomicity is the core of this stage. One `prisma.$transaction` performs a per-user advisory lock, a
conditional consumption update that matches only an unused and unexpired row, a compare-and-swap
credential replacement, supersession of other outstanding tokens, and revocation of every live
session. A failure at any step rolls the whole thing back, so a caller can never end up with a
consumed token and an unchanged password, or a new password with live sessions. Argon2id hashing
happens before the transaction opens so no connection is held across a 64 MiB allocation. Two
concurrent redemptions of one token yield exactly one `204` and one generic failure.

**The password-reset / session-creation race is now closed.** SessionService.createSession had inserted with no coordination, so a login could verify the old password, let a reset complete, and then insert a session authorised by a password that no longer existed - resetting a compromised password did not evict the attacker. Login and reset now take the same transaction-scoped advisory lock, pg_advisory_xact_lock(hashtextextended(user_id, 0)), on the same transaction client that performs their protected writes, and the login revalidates the credential version under that lock. Argon2id stays outside the lock so a 64 MiB allocation is never held under it. Either ordering is now safe: a login that commits first has its session revoked by the reset, and a reset that commits first makes the login observe the advanced version and refuse. No schema column and no migration were added, and no process-local mutex was used. The invariant is proven by 21 real-PostgreSQL concurrency tests using an explicit latch rather than sleeps, including a negative control in which disabling the lock and the revalidation makes the critical test fail with the login succeeding.

Delivery is explicit configuration with no real provider. `API_PASSWORD_RECOVERY_DELIVERY_MODE`
defaults to `disabled`, which fails both endpoints closed with `503` before any write, so no token is
created and no email is attempted. `development-only` uses an in-memory adapter that never writes to
stdout, a logger, a file, or the database, and configuration validation refuses it when
`NODE_ENV=production`. **Real delivery is not available and password recovery is therefore not usable
in production.**

Issuance is enumeration-resistant: unknown address, disabled account, and missing credential return a
byte-identical `202` and perform no write, while still paying a real Argon2id verification against the
Stage 2.4 decoy digest. This is explicitly not a constant-time claim.

Public deployment remains prohibited. Stage 2.5 adds unmitigated abuse risk - recovery email flooding,
token brute force, and especially Argon2id resource exhaustion, since both endpoints can trigger a
64 MiB operation with no throttle. Stage 2.6 owns the fix and no approved rate limiter exists to
reuse.

Local validation passed with no dependency, lockfile, schema, migration, or accepted-document change:
frozen install, Prisma generation, formatting, lint, typecheck across 11 tasks, 135 unit/toolchain
tests, builds across 7 tasks, the aggregate check, 208 integration tests, 19 smoke assertions, mobile
dependency check, Android export, and `git diff --check`. `pnpm audit --audit-level=high` still fails
on exactly the two accepted high advisories with no new finding.

One accepted test was updated: the Stage 2.4 scope regression asserted that the two recovery routes
return `404`, which was correct when recovery did not exist and is superseded now that Stage 2.5
authorizes them. Registration, session-listing, revoke-all, tenant, and refresh routes remain asserted
absent, and the recovery routes are covered by the new suite instead.

Changes are uncommitted, unstaged, and unpushed. **HARD STOP: Stage 2.6 is NOT STARTED /
UNAUTHORIZED.**
