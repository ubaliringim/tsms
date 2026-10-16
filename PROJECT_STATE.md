# TSMS project state

Project: TSMS - TeamStack School Management System

Company: TeamStack Technologies LTD

Updated: 2026-10-16

Phase: Foundation

Stage: 2 - Authentication & Identity

Stage status: AUTHORIZED, not accepted. Owner approved Specification v1.0.

Stage 1 status: ACCEPTED by the project owner on 2026-10-07.

Stage 0 status: ACCEPTED (owner decision, 2026-10-07). Record at tasks/completed/stage-0-engineering-foundation.md.

Latest substage: **Stage 2.9 - Security review and controlled remediation** is ACCEPTED / HOSTED VERIFIED / CLOSED for development (owner decision, 2026-10-16) on implementation commit `3c01a217c4d6202d39ac6f496746e999d48e4379`, hosted run [38873087599](https://github.com/ubaliringim/tsms/actions/runs/38873087599). Stages 2.1-2.8 are likewise ACCEPTED / HOSTED VERIFIED / CLOSED for the accepted development scope. Stage 2 overall: NOT ACCEPTED. Stage 2.10: NOT STARTED / UNAUTHORIZED. Production deployment: NOT AUTHORIZED. Closure is not production readiness.

Stage 2.9 remediation (baseline `64ff6c4`, committed as `3c01a21`): corrections for F-01, F-02, F-03, F-06, F-07, F-08 and F-09 from the read-only
review, each reproduced on isolated infrastructure first. They revise accepted Stage 2.4 and 2.6 behaviour with owner authorization.
Details, evidence and the exact test counts are in tasks/CURRENT.md; the semantics are in docs/security/RATE_LIMITING.md,
AUTH_API.md, PASSWORD_RECOVERY.md and PRODUCTION_CONFIGURATION.md. **F-04 and F-05 were not changed.** The shared source-bucket behind
the web proxy remains an unresolved deployment blocker. A final inspection found and fixed one further F-01 gap (a policy-invalid login
spent the global budget without hashing) and added real-handshake TLS tests. **Stage 2.9 is accepted and closed for development; see the closure record below.**

Expo state (2026-10-16): expo 57.0.28 is installed (package.json plus nine matching lockfile bumps, with no `minimumReleaseAgeExclude`
entry and `minimumReleaseAgeStrict` intact; `pnpm-workspace.yaml` is unmodified). Expo's server now advertises `expo ~57.0.30`, so the
online `pnpm mobile:check` still FAILS locally (exit 1, external). 57.0.30 and its newer `@expo/cli` 57.0.31 and `babel-preset-expo`
57.0.16 are not eligible under the 24-hour policy until about 2026-10-16 14:41 UTC, and no Expo update was made. The CI gate is now
`EXPO_OFFLINE=1 pnpm mobile:check` (passes, exit 0; validates against the installed SDK's bundled metadata only), and a separate
informational job `expo-live-diagnostic` (`pnpm mobile:check:live`, `continue-on-error` on that job only) currently reports INCOMPATIBLE:
installed 57.0.28 is below the advertised `~57.0.30`. It does not replace the offline gate or touch the security audit jobs. Expo's
remote requirements must still be reviewed before production. See docs/architecture/MOBILE_COMPATIBILITY.md. Two defects found in the diagnostic script (an unexpected exception exited 1 instead of 2; unsanitized CLI or server text could inject workflow-command lines into the log) were fixed and verified locally with 30 new tests and 10 negative controls. Local evidence: pnpm test 682 (node:test 114), integration 446, smoke 27,
Android export 578 modules, Chrome E2E 16, `audit:diff` exit 0, and `pnpm audit --audit-level=high` still failing on exactly the two known
advisories. F-04 and F-05 remain unresolved.

### Stage 2.9 closure record (2026-10-16)

Stage 2.9 is ACCEPTED / HOSTED VERIFIED / CLOSED for development (owner decision, 2026-10-16). Implementation commit `3c01a217c4d6202d39ac6f496746e999d48e4379` (`feat(security): complete Stage 2.9 remediation and validation tooling`); hosted run [38873087599](https://github.com/ubaliringim/tsms/actions/runs/38873087599) on that exact SHA (push to main): `validate` = **success** (install, db:generate, `pnpm check`, `pnpm test:integration`, `EXPO_OFFLINE=1 pnpm mobile:check`, `pnpm mobile:export`, `pnpm smoke`, and the clean-tree check), `security-audit-diff` = **success** (findings exactly the two documented), `security-audit` = **failure, expected, on exactly GHSA-86w9-cpqp-85rv and GHSA-vfj7-8cjw-p6xm**, `expo-live-diagnostic` = job conclusion failure by design (informational, `continue-on-error`) with result **INCOMPATIBLE**: installed expo 57.0.28 is below the advertised `~57.0.30`, shown as a workflow warning annotation. Overall workflow: **FAILURE / RED, not green.** Hosted counts: 682 unit/toolchain passed (redis 12, database 17, worker 4, api 308, config 118, web 109, node:test 114), 446 integration passed (redis 66, database 35, api 320, web 25), 27 smoke assertions, Android export of 578 modules. Browser tests are NOT part of hosted CI (16 passed locally in Chrome). The job summary file was written by the script and is viewable on the run page; it was not independently read from the logs.

Retained after closure (closure is not production readiness; production deployment is NOT AUTHORIZED): F-04 targeted account lockout is unresolved; F-05 (shared source-IP bucket behind the same-origin web proxy) is a production deployment blocker; the production ingress and TLS topology is undecided; the CSP is partial; browser tests are local-only; there is no recovery email provider and no idle session expiry; forgot still answers 503 for an ineligible address when the Argon2id semaphore is saturated while an eligible address answers 202; an account at its own success limit refuses faster than an unknown address; recovery issuance can wait on a long reset of the same user and answer 503; the Stage 2.6 and 2.7 limitations remain; both dependency advisories (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm) remain open and unsuppressed; the online `pnpm mobile:check` fails while expo 57.0.28 is below the advertised `~57.0.30` (a later bump needs `@expo/cli` 57.0.31 and `babel-preset-expo` 57.0.16, with no release-age exclusions); and Expo's remote requirements must be reviewed before any production deployment. Stage 2 overall: NOT ACCEPTED. Stage 2.10: NOT STARTED / UNAUTHORIZED.

Stage 2.8: the web app signs in, restores, and signs out through a same-origin proxy of three API routes. No CORS, no API change, no
migration. Specification and risks: [docs/security/WEB_AUTHENTICATION.md](docs/security/WEB_AUTHENTICATION.md). Hosted evidence and the
retained limitations are in the Stage 2.8 closure record below and in tasks/CURRENT.md.

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

Stage 2.5 status: ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Implementation commit `e2bb3b79aa774b64e155b273b35af6dd17a47242` (`feat: add secure password recovery`); hosted run [37859811782](https://github.com/ubaliringim/tsms/actions/runs/37859811782). Record at tasks/CURRENT.md and docs/security/PASSWORD_RECOVERY.md.

Stage 2.6 status: **ACCEPTED / HOSTED VERIFIED / CLOSED** (owner decision, 2026-10-11). Implementation commit `ca66284fb479a00a2c235ae6e18fa3ec7929b98e`; hosted run [38123962717](https://github.com/ubaliringim/tsms/actions/runs/38123962717): `validate` = **success** (245 unit/toolchain, 340 integration, 22 smoke, 3 migrations, 578 modules), `security-audit` = **expected failure on the two accepted advisories**, overall **RED**. **Not deployed.** Record at tasks/CURRENT.md and docs/security/RATE_LIMITING.md.

Stage 2.7 status: **ACCEPTED / HOSTED VERIFIED / CLOSED** (owner decision, 2026-10-12). Implementation commit `d898ae907669d21c99132797b0b6ddfbe5078901` (`feat: add authentication security events and sanitization`); hosted run [38231523798](https://github.com/ubaliringim/tsms/actions/runs/38231523798):
`validate` = **success**, `security-audit` = **failure, expected, on exactly the two accepted advisories**, overall workflow =
**RED, not green**. Hosted counts: 292 unit/toolchain (config 37, redis 4, database 17, worker 4, api 229, toolchain 1),
382 integration (redis 66, database 35, api 281), 22 smoke assertions, 3 migrations applied with 0 pending, Android export of
578 modules, clean-tree check passed.
Authentication security events and sanitization; the accepted Stage 2.1 `AuthenticationEvent` schema is reused
unchanged. **Not deployed.** Record at tasks/CURRENT.md and docs/security/SECURITY_EVENTS.md.

Stage 2.8 status: **ACCEPTED / HOSTED VERIFIED / CLOSED** (owner decision, 2026-10-12). Implementation commit `6ba90869cad6fd3a9ea7f023edcad88e473a1730`; hosted run
[38258942541](https://github.com/ubaliringim/tsms/actions/runs/38258942541): `validate` = **success**, `security-audit` = **failure, expected, on exactly the two accepted
advisories**, overall workflow = **RED, not green**. Same-origin web authentication proxy and minimal sign-in interface; the 16 browser
tests ran locally in Chrome only and are not part of hosted CI. **Not deployed.** Record at tasks/CURRENT.md and
docs/security/WEB_AUTHENTICATION.md.

Stage 2 overall: NOT ACCEPTED. Stage 2.9: NOT STARTED / UNAUTHORIZED.

Exact next action: await separate explicit owner authorization before any further work. Stage 2.9 is NOT STARTED and is NOT
AUTHORIZED, and production deployment is NOT AUTHORIZED. The Stage 2.8 limitations recorded in its closure record, and the Stage 2.7
limitations beneath it, remain open; acceptance of a stage is not production readiness.

DO NOT: start Stage 2.9 or later, deploy to any public network, add a real email provider, add a session-generation column, add registration/email-verification/MFA, change accepted schema/migrations, weaken or suppress audits, amend, force-push, or deploy without explicit authorization.

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

- **Login rate limiting and Argon2id workload protection: implemented, not deployment-validated.** Stage 2.6
  plus its hardening review added Redis-backed per-source and per-account meters, a deployment-wide Argon2id
  rate budget, and a leased semaphore bounding _simultaneous_ Argon2id work. See
  [docs/security/RATE_LIMITING.md](docs/security/RATE_LIMITING.md). What remains unresolved: no proxy-trust
  model, no production HMAC secret chosen, and untuned thresholds. Public internet deployment remains
  prohibited.
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

Public deployment remains prohibited. At Stage 2.5 acceptance these endpoints carried unmitigated abuse
risk - recovery email flooding, token brute force, and especially Argon2id resource exhaustion, since both
could trigger a 64 MiB operation with no throttle. Stage 2.6 and its hardening review now meter all of
them: recovery per-source and per-target requests, reset per-source and per-token attempts, and a
deployment-wide bound on simultaneous Argon2id work. See
[docs/security/RATE_LIMITING.md](docs/security/RATE_LIMITING.md).

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

## Stage 2.5 final security verification, commit and hosted verification - 2026-10-08

The owner accepted Stage 2.5 locally for final security verification and implementation commit. Two
defects were found during that review and corrected.

**The credential version was not a safe unique counter.** `passwordChangedAt` is PostgreSQL
`timestamp(3)` and a JavaScript `Date` is also millisecond, so the accepted `previous + 1` arithmetic
is not truncated and nothing is silently rounded away. But a credential row that is deleted and
recreated can legitimately reuse a timestamp, so the timestamp alone cannot identify credential
state. A live probe reproduced exactly that: delete and recreate the credential with a _different_
password while restoring the original `passwordChangedAt`, and the timestamp comparison passes while
the digest has changed. The in-lock revalidation now also compares a SHA-256 fingerprint of the stored
digest, which is authoritative. Two regression tests cover this, and removing only the fingerprint
while keeping the timestamp makes them fail.

The Argon2id digest is never returned by `verifyCredentialVersioned` and never compared in the clear.
A one-way fingerprint is returned instead and is never logged. The approved Argon2id parameters are
unchanged.

**The advisory-lock key was duplicated.** Password reset carried its own inline
`pg_advisory_xact_lock` expression instead of calling the shared helper, so the key derivation existed
in two places where they could drift apart. It now calls the same helper, and the key exists in
exactly one place. Verification confirms login and reset acquire the identical key on the same
transaction client that performs their protected writes; Argon2id runs before the lock; credential
revalidation, session insertion, credential replacement, and session revocation all occur under it;
xact-scope releases it on rollback; no process-local mutex is used; the accepted `createSession`
signature is retained; and the requirement that every future session-creation path participate is
documented in `user-session-lock.ts`.

The 22 reviewed Stage 2.5 files were committed as `e2bb3b79aa774b64e155b273b35af6dd17a47242` with
subject `feat: add secure password recovery` and pushed normally. No amendment, force push, or
deployment. The baseline `514c859` remains an ancestor. No schema, migration, dependency, or lockfile
change.

[Hosted run 37859811782](https://github.com/ubaliringim/tsms/actions/runs/37859811782) completed for
that exact SHA. `validate` **PASS** with every step green: 139 unit/toolchain tests, 214 integration
tests, 19 smoke assertions, all three migrations applied with none pending, mobile dependency check
and Android export at 578 modules, and tracked-file cleanliness. Hosted counts match local exactly.
`security-audit` **EXPECTED FAIL** on exactly node-forge GHSA-86w9-cpqp-85rv and braces
GHSA-vfj7-8cjw-p6xm, both high, both with no patched release, no new advisory and no suppression. No
other jobs and no unexpected failures. **The overall workflow is red and is not green.** The Actions
Node 20-to-24 warning and the Ubuntu migration notice persist unchanged.

Stage 2.5 is HOSTED VERIFIED / AWAITING FINAL OWNER ACCEPTANCE. Stages 2.1 through 2.4 acceptance are
untouched. Stage 2 overall remains NOT ACCEPTED. Stage 2.6 remains NOT STARTED / UNAUTHORIZED. These
hosted-results documentation updates are deliberately left uncommitted.
**HARD STOP: no documentation closure commit, no deployment, and no Stage 2.6.**

## Stage 2.5 final documentation closure - 2026-10-08

The owner accepted Stage 2.5 and authorized committing only PROJECT_STATE.md, project-state.json and
tasks/CURRENT.md with subject `docs: close Stage 2.5 hosted validation`, then pushing main normally.
Before that commit the working tree was confirmed to hold exactly those three modified documentation
files, with nothing staged, nothing untracked, and no implementation, test, schema, migration,
dependency, lockfile, configuration, or CI file touched. Both HEAD and `origin/main` equalled the
accepted implementation SHA `e2bb3b79aa774b64e155b273b35af6dd17a47242`.

Recorded hosted results, unchanged from the verification checkpoint: `validate` PASS; 139
unit/toolchain tests; 214 integration tests; 19 smoke assertions; three Prisma migrations applied
with none pending; mobile dependency check and Android export PASS at 578 modules; `security-audit`
EXPECTED FAIL on exactly the two documented high-severity advisories. The overall workflow remains red
and is **not** green. Neither advisory is marked resolved.

### Accepted synchronization protocol

- Login and password reset acquire the **same** transaction-scoped PostgreSQL advisory lock,
  `pg_advisory_xact_lock(hashtextextended(user_id, 0))`, on the **same transaction client** that
  performs their protected writes. The key exists in exactly one place, in a shared helper.
- Argon2id verification runs **outside** the lock, so a 64 MiB three-iteration allocation is never
  held under it and concurrent logins for one user are not serialised by hashing.
- Login revalidates the credential under the lock before creating a session, comparing **both**
  `passwordChangedAt` and a SHA-256 fingerprint of the stored digest. The digest itself is never
  returned and never logged.
- Password replacement, recovery-token consumption, outstanding-token invalidation, and session
  revocation are **atomic**: one transaction, all or nothing.
- Existing sessions **are** revoked during a reset.
- Recovery creates **no** session; the user must log in again.
- In-flight HTTP requests are **not** canceled by a reset. Revocation affects subsequent validation
  only.

No broader concurrency guarantee is claimed than the implementation provides.

### Unresolved risks preserved

Per-user login serialization during the short locked transaction; advisory-lock coordination applying
only to participating writers; no production email provider; recovery unavailable in production;
recovery email flooding; token-request abuse; token brute-force attempts; Argon2id resource
exhaustion; no comprehensive rate limiting; public deployment prohibited; deferred credentialed
CORS and the broader CSRF design; and every previously documented infrastructure, Prisma, CI,
native-platform, and dependency follow-up. `node-forge` GHSA-86w9-cpqp-85rv and `braces`
GHSA-vfj7-8cjw-p6xm remain **unresolved**, both installed, neither with a patched upstream release.

Stage 0: ACCEPTED. Stage 1: ACCEPTED. Stage 2.1: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2:
ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.3: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.4:
ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.5: ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2 overall:
NOT ACCEPTED. Stage 2.6: NOT STARTED / UNAUTHORIZED. **HARD STOP.**

## CI reliability: concurrent Prisma generation resolved - 2026-10-08

This is a maintenance task, not a new stage. Stage 2.5 acceptance history is unchanged and all stage
statuses are preserved.

**Incident.** Hosted run 37860601281 failed `pnpm check` with `TS6053: File
'packages/database/src/generated/prisma/client.ts' not found`. Run 37859811782, on the identical commit,
passed, so this was an intermittent race rather than a deterministic failure.

**Confirmed root cause.** `packages/database` declared both `build` and `typecheck` as
`prisma generate && tsc ...`, while `turbo.json` gave both only `dependsOn: ["^build"]`. The `^` prefix
orders a package's dependencies, not its own tasks, so `@tsms/database#build` and
`@tsms/database:typecheck` were scheduled in parallel. Both wrote `src/generated/prisma`, and one
task's `tsc` read the directory while the other was rewriting it.

**Fix.** Generation now has a single owner. `db:generate` is a dedicated Turbo task and the sole
writer; `build` and `typecheck` depend on it and only read its output. The database package scripts no
longer invoke Prisma. The task graph went from two parallel writers to one writer ordered before both
readers.

**Caching.** `db:generate` is `cache: false` on purpose. Generation costs roughly 150-400 ms, and an
uncached task removes any chance of an incomplete or stale restored directory being treated as a
successful generation, which is exactly the property the incident was about. `build` and `typecheck`
keep normal caching; their inputs are git-tracked files, and the schema, Prisma config, and Prisma
version are all tracked, so any relevant change alters the hash. No migration command was added to
any build, typecheck, or generate task, and generation requires no database.

**A related defect found at the same time.** `API_PASSWORD_RECOVERY_DELIVERY_MODE` and
`API_PASSWORD_RECOVERY_URL_BASE` were documented and read by the API but missing from the Turbo
`globalEnv` list, so they could not affect a cache key. Both were added.

**Validation.** Five consecutive `pnpm check` runs, each starting from a deleted generated-output
directory, all passed with no failure and no concurrent generation observed. `pnpm build`,
`pnpm typecheck`, `pnpm test`, `pnpm check`, and `pnpm test:integration` were each verified
individually from a clean generated state. Full repository validation passed: 148 unit/toolchain
tests, 214 integration tests, 19 smoke assertions, builds, mobile checks, and `git diff --check`. The
audit still fails on exactly the two accepted high advisories with no new finding.

**Regression coverage.** `packages/database/tests/generation.test.mjs` asserts the ownership
property structurally rather than by timing, so it cannot itself be flaky, and it fails the build if
the graph regresses. Reintroducing the original defect fails two of its assertions.

**Ergonomics change.** Direct package invocations such as `pnpm --filter @tsms/database typecheck` no
longer generate the client first and require `pnpm db:generate` beforehand. The supported root-level
commands are unaffected. This is recorded in the package script notes and
docs/architecture/DEPENDENCY_REVIEW.md.

The Stage 1 follow-up recording this race is **FIX IMPLEMENTED / LOCALLY VALIDATED / HOSTED
VERIFICATION PENDING**, not yet resolved: the correction must be confirmed by a hosted validate run before the follow-up can close. No
dependency, lockfile, schema, migration, authentication, tenant, or mobile change was made.

## CI reliability: hosted confirmation - 2026-10-09

The maintenance fix was committed as `29153a0d57271f30d9e9212818b368926adb431b` (`fix: serialize Prisma
client generation in build graph`) and pushed normally. No amendment, force push, or deployment. The
baseline `70c572d` remains an ancestor.

[Hosted run 37863994222](https://github.com/ubaliringim/tsms/actions/runs/37863994222) completed for
that exact SHA. `validate` **PASS** with every step green: 148 unit/toolchain tests, 214 integration
tests, 19 smoke assertions, three Prisma migrations applied with none pending, an Android export of 578
modules, and tracked-file cleanliness. Hosted counts match local exactly.

The decisive evidence is the Prisma task behaviour on a clean Linux runner: `@tsms/database#build` and
`@tsms/database:typecheck` each invoke **zero** Prisma commands, and `TS6053` occurs **zero** times.
`prisma generate` runs only from the `db:generate` task and from the explicit `pnpm db:generate` CI
step. The accepted single-writer graph therefore behaves as designed on hosted CI.

`security-audit` **EXPECTED FAIL** on exactly node-forge GHSA-86w9-cpqp-85rv and braces
GHSA-vfj7-8cjw-p6xm, both high, no new advisory, no suppression. The overall workflow remains red for
that accepted reason only and is **not** green.

The historical failure is preserved rather than erased: hosted run 37860601281 remains the incident
record and its cause is restated in docs/architecture/DEPENDENCY_REVIEW.md. The Stage 1 follow-up is
recorded as fixed, locally validated, and hosted verified, and stays open pending the owner closure
decision.

Stage 2.5 remains ACCEPTED / HOSTED VERIFIED / CLOSED and its closure history is unchanged. Stage 2
overall remains NOT ACCEPTED. Stage 2.6 is ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2.7 is ACCEPTED / HOSTED VERIFIED / CLOSED. (Historical wording: when this was written, Stage 2.8 was NOT STARTED / UNAUTHORIZED.)

## Stage 2.8 - Minimal Web Authentication Integration - 2026-10-12 (closed 2026-10-12)

### Closure record - 2026-10-12

Implementation commit `6ba90869cad6fd3a9ea7f023edcad88e473a1730` (`feat: integrate minimal web authentication`); hosted run [38258942541](https://github.com/ubaliringim/tsms/actions/runs/38258942541):
`validate` = **success** (every step, including `pnpm check`, `pnpm test:integration`, `mobile:check`, `mobile:export`, `pnpm smoke`, and the
clean-tree check), `security-audit` = **failure, expected, on exactly the two accepted advisories**, overall workflow = **FAILURE / RED, not
green**. Hosted counts: 401 unit/toolchain passed (config 37, redis 4, database 17, worker 4, api 229, web 109, toolchain 1), 407 integration
passed (redis 66, database 35, api 281, web 25), 23 smoke assertions passed, 3 migrations applied, Android export of 578 modules.
**Browser tests are NOT part of hosted CI:** the 16 Playwright tests passed locally in an installed Google Chrome only, and nothing in
GitHub Actions ran them. The dependency audit remains unsuppressed and reports node-forge `GHSA-86w9-cpqp-85rv` and braces `GHSA-vfj7-8cjw-p6xm`.

Scope delivered: same-origin Next route handlers for `login`, `me`, and `logout`; header allowlists in both directions; the browser
`Origin` forwarded verbatim; no cookie forwarded on login; streaming, byte-counted request limit (4 KiB) and per-route response caps;
refusal of a session `Set-Cookie` outside the accepted cookie contract; `TSMS_API_ORIGIN` (server-only, required in production, https
unless loopback); a minimal sign-in, restoration, and sign-out interface; a partial CSP; unit, real-chain integration, and local browser
tests. No change to the API, Stage 2.6 attribution or limits, Stage 2.7 behaviour, migrations, or the cookie contract.

**Limitations retained at closure.** Closure is acceptance for the development scope, **not production readiness**.

1. Shared source-IP rate-limit exhaustion: behind the same-origin web proxy every browser reaches the API from the web server's address, so the Stage 2.6 per-source meters become one budget for all users. Unresolved deployment blocker; Stage 2.6 was deliberately not changed.
2. Production topology, trusted ingress, and TLS termination are unknown, and no deployment has occurred.
3. There is no approved trusted client-IP forwarding model (no trusted-proxy list, no forwarded-header trust, no signed client-address assertion).
4. The Content-Security-Policy is partial (object-src, base-uri, frame-ancestors, form-action, connect-src) with no script-src or default-src. It is not an XSS defence; a script-restricting policy needs an owner decision (nonces and dynamic rendering).
5. Browser testing is local only and Chrome only; it is not in hosted CI.
6. Production HTTPS and the `Secure` / `__Host-` cookie behaviour in a browser have not been verified. A non-loopback API origin must use HTTPS (enforced).
7. After an oversized or abandoned request body Node will not serve another request on that keep-alive socket until it closes; new connections are unaffected.
8. Stage 2.6 limitations remain: Redis as a hard dependency, HMAC secret provisioning and rotation, provisional rate-limit thresholds, lease-expiry over-admission, lost refunds, untested Redis Cluster.
9. Stage 2.7 limitations remain: non-durable per-process security logs, undefined log and event retention and access, one SESSION_REVOKED row per revoked session, and password reset can fail closed at very high live-session counts.
10. There is no real password-recovery email provider, so recovery is unavailable in production.
11. There is no idle session-expiry timer and no double-submit CSRF token (the Origin check covers the two mutating routes).
12. Both dependency advisories remain OPEN and unsuppressed: node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm.
13. The development machine has had local disk-space pressure, which coincided with intermittent local failures during validation.

## Stage 2.7 - Security Events & Sanitization - 2026-10-11 (closed 2026-10-12)

_The notes below were written during implementation and review. They are retained as history; where they say
"locally validated", "under review", or "pending", the current state is the closure record directly beneath._

### Closure record - 2026-10-12

Implementation commit `d898ae907669d21c99132797b0b6ddfbe5078901` (`feat: add authentication security events and sanitization`); hosted run [38231523798](https://github.com/ubaliringim/tsms/actions/runs/38231523798):
`validate` = **success**, `security-audit` = **failure, expected, on exactly the two accepted advisories**, overall workflow =
**RED, not green**. Hosted counts: 292 unit/toolchain (config 37, redis 4, database 17, worker 4, api 229, toolchain 1),
382 integration (redis 66, database 35, api 281), 22 smoke assertions, 3 migrations applied with 0 pending, Android export of
578 modules, clean-tree check passed.

**Limitations retained at closure.** Closure is acceptance for development, **not production readiness**.

1. Password reset can fail closed at sufficiently high live-session counts: a reset is one transaction under
   Prisma's 5 s default and no per-user session cap exists. Success at 100,000 sessions was a local observation on
   one machine, not a production guarantee.
2. One `SESSION_REVOKED` event is written per session actually revoked.
3. `LOGIN_SUCCEEDED` has no per-account event-volume bound, only the global Argon2id budget.
4. Security logs are non-durable, throttled per process, and are not audit events.
5. Log retention, centralised collection, restricted access, and alerting are production prerequisites.
6. `AuthenticationEvent` table retention and read access remain undefined; no event read API exists.
7. Integration performance varies under host memory pressure.
8. Stage 2.6's Redis, proxy, HMAC, and abuse-control limitations remain.
9. Both dependency advisories remain **OPEN and unsuppressed**: node-forge `GHSA-86w9-cpqp-85rv` and braces
   `GHSA-vfj7-8cjw-p6xm`.
10. The historical test-database rows (581 users, plus one residual user with six events) were intentionally not
    deleted, and `apps/api/probe.txt` remains an unexplained untracked file.

### Implementation and review history

**Status: ACCEPTED / HOSTED VERIFIED / CLOSED** (owner decision, 2026-10-12).
**Not deployed.** No schema or migration change: the accepted Stage 2.1 `AuthenticationEvent` model is reused
unchanged.

Authentication outcomes now produce accurate, privacy-minimised security events. Success events are written
on the same transaction as the operation they describe, so a committed success event always corresponds to a
committed operation; failure events are best-effort so a lost audit row can never change a response and
create an enumeration oracle. Denial, outage, and Argon2id-refusal outcomes have no representable event
type and are recorded instead as throttled, sanitised log lines, which bounds event volume to what the
Stage 2.6 abuse limiter already permits.

Design, taxonomy, transaction boundaries, volume controls, and limitations are specified in
[docs/security/SECURITY_EVENTS.md](docs/security/SECURITY_EVENTS.md).

**Escalated for owner decision.** Rate-limit denials, Redis unavailability, Argon2id admission refusals, and
rejected recovery tokens are not queryable in the event table. Making them first-class events requires
extending `AuthenticationEventType`, which is a migration and therefore needs separate authorization.

**Three defects were found and fixed while implementing this stage**, including an API startup abort caused
by a type-only import of a constructor-injected dependency, which was silent because Nest logging is
disabled. A negative control confirmed the transaction-coupling test genuinely detects a decoupled write;
an earlier version of that test passed under the same control and was replaced because it proved nothing.

**A takeover review (Claude Code, 2026-10-11) found and fixed further defects:** `SESSION_REVOKED` was
double-reported when a logout raced a reset; `abortOnError` still hid every future startup failure; the
exception filter held a second log instance; two refusal paths wrote no record; `dist` could be stale with no
guard; and one accepted suite never cleaned up its users. Event volume was re-analysed: `LOGIN_SUCCEEDED` is
bounded only by the global Argon2id budget and `SESSION_REVOKED` fans out to an uncapped session count.
Local validation was re-run to completion: 292 unit/toolchain, 375 integration (api 274, since 382 with api 281), 22 smoke, audit
failing on exactly the two accepted advisories. 581 historical synthetic rows remain in `tsms_test` (deletion
not approved), plus one user and six events left by a failed run.

**Final design review (2026-10-11).** Owner approved log-only handling for rate-limit, Redis, Argon2id and
rejected-token outcomes; a migration, a session cap, an aggregate revocation row, deleting test rows and
removing `apps/api/probe.txt` were not approved. `SESSION_REVOKED` is one truthful row per revoked session and
was measured: the original per-row write failed closed at 20,000 live sessions (Prisma 5 s transaction
timeout). The detached `LOGIN_FAILED` write was hardened so it cannot reject. Log lines are documented as
non-durable, not audit events.

**Fan-out correction (2026-10-12).** The owner authorised a narrow correction. `SESSION_REVOKED` is now
written by one set-based statement (`UPDATE ... RETURNING` into `INSERT ... SELECT`) on the reset transaction,
exactly one row per session that statement revoked, with a UUIDv7 built in SQL because PostgreSQL 17 has no
`uuidv7()`. No schema change, no session cap, no change of event meaning. Benchmarks on the reference machine:
success through 100,000 live sessions (marginal from 50,000), failure at 150,000; the accepted revoke-only
baseline fails between 100,000 and 200,000. A test-lifecycle defect (requests outliving a timed-out test and
writing events after teardown) was fixed with a settle-before-teardown guard. An intermittent 30 s timeout was
not reproduced and is attributed, unproven, to host memory pressure. Integration is now 382 (api 281), unit 292.
A reset is still one transaction and still fails closed near 100,000+ live sessions. Stage 2.7 is ACCEPTED / HOSTED VERIFIED / CLOSED (not production readiness).

## Stage 2.6 - Rate limiting and abuse protection - 2026-10-09

**Status: ACCEPTED / HOSTED VERIFIED / CLOSED** (owner decision, 2026-10-11). **Not deployed.** Hardened
after an owner-commissioned review closed two real weaknesses, committed and pushed as
`ca66284fb479a00a2c235ae6e18fa3ec7929b98e`, and verified by hosted run
[38123962717](https://github.com/ubaliringim/tsms/actions/runs/38123962717).

All five authentication routes are now protected by Redis-backed distributed meters that share state
across API instances, and **all Argon2id work is bounded both by rate and by a deployment-wide bound of
8 valid leases**. The design, policies, key construction, outage behaviour, and residual risks are
specified in [docs/security/RATE_LIMITING.md](docs/security/RATE_LIMITING.md).

## Stage 2.6 hardening review - 2026-10-09

An owner-commissioned review investigated two potential weaknesses. **Both were real**, and both had been
previously written up as acceptable limitations - which is precisely what made them worth reviewing.

### Finding 1: concurrent requests bypassed every failure-metered limit

**Root cause.** Admission for a failure-metered endpoint was a _check that wrote nothing_, and the charge
happened after the handler returned. The admission decision and the charge were therefore not atomic, so N
simultaneous requests all read the same untouched bucket and all proceeded. The limiter's own documentation
described this as "bounded by the number of requests already in flight" - a phrasing that turned a real
bypass into what looked like an accepted limitation.

**Demonstrated, not assumed.** Against real Redis, before any fix: **20 concurrent failed logins were all
admitted against a configured per-account allowance of 8** (`{admitted: 20, refused: 0}`). Twenty concurrent
invalid reset attempts were all admitted against an allowance of 10. The same burst split across two
independently created API instances was likewise fully admitted, confirming the bypass was distributed
rather than per-process.

**Correction: reserve, then refund.** Admission now reserves a token on every dimension atomically, so
simultaneous requests contend for real state. The reservation is refunded whenever the outcome was not a
credential failure, which is what keeps a legitimate attempt free. `AUTHENTICATION_FAILED` and
`RECOVERY_TOKEN_INVALID` keep their reservation; the refusal set is exported as `CHARGED_ERROR_CODES` so it
cannot change silently if a handler is refactored.

**Result.** A burst of twenty against an allowance of eight now admits at most eight. Same for reset, same
across separate instances. Sequential and concurrent traffic are bounded identically - concurrency changed
the mechanism, not the limit.

### Finding 2: no bound on simultaneous Argon2id allocations

**Root cause.** A per-minute bucket bounds work _started_, not work _running_. A bucket that starts full
hands out its entire capacity at once, so the 120-token budget permitted a 120-way burst of 64 MiB
allocations. No concurrency bound existed. This had been explicitly escalated rather than claimed as
solved, which was the correct call.

**Correction: a deployment-wide leased semaphore**, enforced immediately before every allocation. One Redis
sorted set of lease holders; each member is a 32-byte random id scored by its expiry; acquire prunes expired
members and refuses at capacity, release removes only that holder and only if present, renew extends only
that holder and only if present.

**Why a Redis lease is safe here specifically.** Every endpoint that can reach Argon2id _already_ failed
closed when Redis was unreachable, because the rate limiter is consulted first. Adding a Redis-backed
admission step therefore introduces **no new failure mode**: if Redis is down, the request was already going
to be refused before any Argon2id was attempted.

**Every Argon2id path is covered** - real verification, the decoy burn for an unknown or ineligible
account, and reset credential hashing - because both services take the admission service as a _required_
constructor argument rather than an optional one.

**Sizing, and why 8.** 512 MiB of transient allocation fleet-wide, roughly 80 verifications per second. The
bound must sit _above_ the product's legitimate concurrency: the accepted Stage 2.5 contract includes six
concurrent valid logins all being admitted, and an initial capacity of 4 broke exactly that. A control below
legitimate concurrency is the outage, not the protection.

**Residual.** A lease that expires while its work is still running permits bounded over-admission. The lease
is 30 s against a ~100 ms operation with renewal every 10 s, so it requires an event-loop-starved process.
Recorded rather than hidden.

### Secret validation hardened

A length check alone does not establish a secret - `'x'.repeat(32)` satisfies any minimum length and carries
almost no entropy. Startup now also rejects a single repeated character or a short repeating pattern. The
rule is deliberately narrow and is **not** a claim to measure entropy: a legitimate hex-shaped secret, which
is what `crypto.randomBytes(32)` renders as, is explicitly accepted, because rejecting it would push
operators toward weaker values. Sharing across replicas, injection rather than commitment, and never logging
remain operational requirements, recorded as deployment blockers.

### Four defects found during the hardening itself

1. **Redis replies to `TIME` with bulk strings.** The semaphore assumed numbers, so every admission was refused as unreadable and login and both recovery endpoints returned `503`. Found by an integration run failing every login; the unit test could not have caught it because it supplied the numeric shape the code wrongly expected.
2. **An admission refusal in password reset was reported as a password-policy violation** (`400`) instead of a service failure - conflating two distinguishable outcomes and disclosing that no hashing had been attempted. Found by the existing Stage 2.5 reset suite.
3. **The crash-recovery test passed with the expiry prune removed**, because the key `PEXPIRE` was reclaiming capacity instead of the prune. A test that could not detect its own defect. Found by a deliberate negative control. The test was rewritten to isolate the prune and now fails when it is removed.
4. **The concurrency bound of 4 broke an accepted guarantee**, refusing the excess in the Stage 2.5 suite that asserts six concurrent valid logins succeed. Found by the accepted suite the hardening was required not to weaken.

### Negative controls

Three, each run deliberately to confirm the tests detect what they claim:

- **The bypass itself** - the probe suite recorded the pre-fix behaviour verbatim (20 admitted of 20); after the fix the same probe is bounded.
- **The expiry prune** - removing it left the original test green, proving the test was detecting the key TTL. After the rewrite, removing it fails the test.
- **The all-or-nothing write rule** - making a refused request write to every dimension fails 3 tests.

### A test-isolation defect found and fixed

Three consecutive full-suite runs exposed intermittent failures in the hardening suites. The cause was
cross-suite interference over state that is **deployment-wide by design**, not a defect in either control.

- The Argon2id semaphore is one key spanning every instance, so it is shared deployment state, not a per-suite fixture.
- `apps/api` and `packages/redis` integration suites run concurrently against the same logical Redis database, and both asserted on that shared key.
- `packages/redis` has an **accepted Stage 1 test that calls `FLUSHDB`** on the test database, deleting the semaphore and the rate-limit buckets out from under `apps/api` mid-run.
- A first attempt excluded the semaphore key from the API suites' cleanup, which fixed the cross-package collision but then left stale holders from earlier suites within the same package, because those run sequentially.

**Resolution.** The root `test:integration` script now runs `@tsms/redis` first and every other package
afterwards, so the `FLUSHDB` cannot overlap another suite. The Redis semaphore suite additionally uses its
own key namespace. The API suites reset the full rate-limit namespace, including the semaphore, because
they own it exclusively. Turbo cannot express a cross-package task dependency without also declaring it for
every package, which fails with `depends on itself`, so sequencing at the root script is the smallest
correct change.

**Not changed:** the `FLUSHDB` assertion is preserved unchanged and still proves a flush is scoped to the
logical database. No production code changed, and the Prisma generation task graph is untouched.
**Verification:** three consecutive full `pnpm test:integration` runs, all green - 52 Redis, 35 database,
239 API.

### Hardening validation

Frozen install PASS (lockfile unchanged) · db:generate PASS (no schema or migration change) · format PASS ·
lint PASS (zero warnings) · typecheck PASS (12 tasks) · unit tests PASS at **233** (config 37, Redis 4,
database 17, worker 4, API 182 including 61 rate-limit and 24 hardening cases, plus one Node toolchain test) ·
build PASS (8 tasks) · check PASS · integration tests PASS at **326** (API 239 including 6 concurrency-probe
and 30 hardening cases, Redis 52 including 15 semaphore cases, database 35), none skipped, 3 migrations with
0 pending · smoke PASS at 22 · mobile check PASS · Android export PASS at 578 modules · git diff --check
PASS. Audit **EXPECTED FAIL** on exactly node-forge `GHSA-86w9-cpqp-85rv` and braces
`GHSA-vfj7-8cjw-p6xm` - no new finding, no suppression, threshold unchanged. Hosted CI **NOT RUN**,
because nothing is committed.

One unrelated observation: a single `pnpm test` invocation failed in the Next.js **control** build because
`/_global-error` exceeded its 60-second budget and was retried. It passed on the following invocation and no
Stage 2.6 file is involved in that build.

### The original Stage 2.6 record

**Status: superseded by the hardening record above.** The implementation described here was hardened
before commit and is now `ca66284`; the pre-hardening wording is retained as history only and no longer
describes the committed code. All five authentication routes are now protected by Redis-backed
distributed meters that share state across API instances. The design, policies, key construction, outage
behaviour, and residual risks are specified in
[docs/security/RATE_LIMITING.md](docs/security/RATE_LIMITING.md).

**Algorithm.** One Redis Lua script evaluates every dimension of a request atomically as a token
bucket. A request is admitted only when every dimension has capacity, and **nothing is written unless
every dimension admits**, so a refusal cannot drain an unrelated budget. Time comes from Redis `TIME`,
never the caller, so every instance refills identically despite local clock skew. The script that
creates a key also sets its expiry, so no crash leaves a key without a TTL. Every key carries the
`{tsms-rl}` hash tag, keeping a multi-key script inside one cluster slot.

**Trusted client identity.** The transport peer address only. `X-Forwarded-For`, `X-Real-IP`,
`Forwarded`, `CF-Connecting-IP`, `True-Client-IP`, `X-Client-IP`, and `X-Original-Forwarded-For` are
all ignored, as are `request.ip` and `request.hostname`. `trust proxy` is not enabled and there is no
configuration to enable it. Addresses are normalised so IPv4, IPv4-mapped IPv6, IPv4-compatible IPv6,
and every RFC 5952 spelling of an IPv6 address resolve to one bucket; scoped addresses are rejected
and an unusable peer collapses to one shared bucket. **No claim is made that TSMS can identify an
individual client**: every device behind one NAT shares a source bucket, which is why per-account and
per-target meters are always applied alongside it.

**Key privacy.** Keys are `tsms:rl:v1:{tsms-rl}:<endpoint>:<dimension>:<128-bit hex HMAC>`. No raw
email address, recovery token, session token, password hash, or request body ever becomes key
material. The endpoint and dimension are inside the HMAC message, so one subject cannot be correlated
across endpoints from key material alone. The secret is `API_RATE_LIMIT_HMAC_SECRET`, validated at
startup and required in every environment; it is not authentication material, and **every replica must
share it**, because per-instance values silently turn a distributed limit into a per-instance one.

**Policies.** Login 10 per 5 min per address and 8 per 15 min per account; recovery 5 per 15 min per
address and 3 per 1 h per target; reset 10 per 15 min per address and per token; `me` 120 per min;
`logout` 30 per min; plus a global Argon2id budget of 120 per minute across the whole deployment. The
numbers are conservative development defaults chosen against a measured ~100 ms Argon2id cost, not
industry-standard guidance, and they are frozen source constants rather than environment variables.

**Requests versus failures.** `login` and `reset` are metered on **failures**, so a correct sign-in
spends nothing and colleagues behind one NAT cannot lock each other out. `forgot` is metered on
**requests**, which is essential rather than stylistic: the abuse it exists to stop is email flooding,
and a flooding request _succeeds_ - it answers `202` and sends a message - so a failure-metered control
would have limited nothing at all.

**Outage behaviour.** Login and both recovery endpoints fail closed with the accepted fixed `503`
before any Argon2id is attempted and before any recovery token is issued. A malformed Redis reply is
never treated as permission. Redis timeouts are bounded at 750 ms. Driver messages are discarded
because ioredis can include the connection password. `me` proceeds during an outage because it spends
nothing. Logout proceeds **and still revokes**, because revocation is a PostgreSQL write and Redis only
ever provided the throttle: the cookie is cleared and the `204` remains a truthful claim.

**Enumeration resistance.** Target keys derive from the normalised address, so existing and nonexistent
accounts are metered identically with no database lookup on the key path. Recovery is metered by
request precisely so an unknown target is not free. Known and unknown targets return byte-identical
status, body, and headers at every position including the refusal. Not a constant-time claim.

**Defects found and fixed during implementation**, each caught by a test rather than by review:

1. IPv6 canonicalisation emitted padded groups, so `2001:db8::1` and `2001:0db8::0001` were two
   different clients with two independent buckets - a bypass by textual representation alone.
2. A failure-metered recovery meter would never have limited anything, since flooding requests succeed.
3. The initial design charged successful logins, letting one NAT address lock out correct users.
4. A malformed recovery token produced no target dimension, leaving non-canonical guessing unmetered.

**Validation.** Frozen install PASS with an unchanged lockfile; `db:generate` PASS with no schema or
migration change; format PASS; lint PASS with zero warnings; typecheck PASS across 12 tasks; unit tests
PASS at 208 (config 26, Redis 4, database 17, worker 4, API 157 including 61 focused Stage 2.6, plus
one Node toolchain test); build PASS across 8 tasks; `check` PASS; integration tests PASS at 275 (API
203 including 32 focused Stage 2.6, Redis 37, database 35), none skipped, 3 migrations with 0 pending;
smoke PASS at 22 assertions including 3 new startup-failure cases for the required secret; mobile check
PASS; Android export PASS at 578 modules; `git diff --check` PASS. `pnpm audit --audit-level=high`
**EXPECTED FAIL** on exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm - no new
finding, no suppression, threshold unchanged. Hosted CI was **not run** at this checkpoint, because nothing
was committed yet; it was subsequently run as `38123962717` on `ca66284` after the hardening review.

**Escalation for owner decision.** No bound on simultaneous Argon2id verifications is enforced. The global
budget caps Argon2id verifications **started**, not **simultaneous** 64 MiB allocations. A genuine
concurrency cap requires leases with expiry and reviewed release semantics; a half-built distributed
semaphore can deadlock or double-release, which is worse than an honest rate bound. This is the main gap
Stage 2.6 leaves open. Separately, a TLS-terminating load balancer would collapse every client onto one
source bucket, and no proxy-trust model has been
decided. Both need owner decisions before public deployment, along with a production HMAC secret.

**Superseded by the hardening review above, and the escalation is now decided.** The concurrency bound is
enforced by a deployment-wide leased semaphore with a provisional capacity of 8 valid leases, and the
concurrent-bypass weakness is closed by reservation with refund. The owner has recorded these decisions:
capacity 8 is provisional; Redis is a hard dependency for login and password recovery; transport-peer
identity remains authoritative and no trusted proxy model is approved; production use behind a shared
TLS-terminating proxy remains blocked pending architecture review; `API_RATE_LIMIT_HMAC_SECRET` must be
securely injected and shared by every replica; development thresholds remain provisional and production
tuning is deferred.

**Still open and not resolved by acceptance.** Lease-expiry over-admission - the bound is on valid leases,
not on physically running Argon2id operations. Redis unavailability makes login and both recovery endpoints
unavailable. A refund that cannot be written is lost. There is no approved trusted proxy model. HMAC secret
rotation resets every active window and fails open for up to one window. Redis Cluster has not been
exercised. Production email delivery is not configured. **This stage is not production readiness and
production deployment remains prohibited.**

**Unchanged.** Argon2id parameters, the password policy, recovery token entropy and expiry, token
single-use, reset transaction atomicity, the shared advisory-lock protocol, credential fingerprint
revalidation, exact trusted-origin validation, secure cookie settings, strict JSON validation, the 4
KiB body limit, database isolation guards, and `no-store` on every authentication response. No schema,
migration, dependency, lockfile, or CI change. No credentialed CORS, no registration, and no Stage 2.7
`AuthenticationEvent` recording.

## CI reliability follow-up: documentation closure - 2026-10-09

The owner accepted the Prisma generation race correction and authorized this documentation-only closure.

The specific Stage 1 concurrent Prisma generation issue is **RESOLVED** and removed from the active
unresolved list. Its history is preserved rather than erased:

- **Original failure:** EEXIST on `generated/prisma/internal` from two tasks regenerating the same output.
- **Subsequent hosted failure:** run 37860601281, `TS6053: File 'packages/database/src/generated/prisma/client.ts' not found`. A flake; run 37859811782 passed on the identical commit.
- **Confirmed root cause:** database `build` and `typecheck` independently invoked `prisma generate`, and `dependsOn: ["^build"]` ordered only dependencies, so they ran in parallel.
- **Accepted correction:** one uncached `db:generate` task, ordered before both consumers, which only read its output.
- **Implementation commit:** `29153a0d57271f30d9e9212818b368926adb431b`.
- **Successful hosted validation:** run 37863994222, `validate` PASS, zero `TS6053`, zero Prisma invocations from either consumer.
- **Regression coverage:** 9 structural tests in `packages/database/tests/generation.test.mjs`; reintroducing the defect fails two of them.
- **Local validation:** 5 consecutive clean-state parallel passes, 0 failures; cache-hit and cold-cache behaviour both verified; all supported entry points verified from a deleted generated-output directory.

Hosted results as recorded: `validate` PASS; 148 unit/toolchain tests; 214 integration tests; 19
smoke assertions; 3 Prisma migrations applied with 0 pending; Android export of 578 modules;
`security-audit` EXPECTED FAIL on exactly the two known high-severity advisories. **The overall workflow
is RED and is not marked green.**

**Remaining limitation.** Direct package-level commands such as `pnpm --filter @tsms/database typecheck`
no longer generate the client first and require `pnpm db:generate` beforehand. Supported root-level
commands are unaffected.

**Not resolved by this closure.** This resolves only the generation-ownership race. All 14 unrelated
known issues are preserved and none was marked resolved, including: both high-severity advisories still
unresolved and still installed; the two scoped Prisma overrides awaiting upstream pins; the Actions
Node 20-to-24 runtime warning; the ubuntu-latest to Ubuntu 26 migration notice; ESLint 9.39.5
deprecation; native device and store builds not run; non-amd64 image verification; the Compose
PostgreSQL major-version tag pin; development-only local credentials; the deferred audit-exception
mechanism; and InfrastructureProbe retirement through a future forward migration.

Stage 0 ACCEPTED. Stage 1 ACCEPTED. Stages 2.1 through 2.5 ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2
overall NOT ACCEPTED. Stage 2.6 NOT STARTED / UNAUTHORIZED. No authentication, recovery, schema,
migration, dependency, or CI behaviour was changed by this maintenance closure.
**HARD STOP: no deployment and no Stage 2.6.**
