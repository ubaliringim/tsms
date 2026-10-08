# Current task: Stage 2.2 - Password Credential Service

Owner: TeamStack Technologies LTD

Stage 1: ACCEPTED. Stage 2.1: ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2.2: ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2 overall: NOT ACCEPTED. Stage 2.3 Session Foundation: NOT STARTED / UNAUTHORIZED.

Started on main at 221f17aaab495c9df92548b351eff53ab8c363b5, equal to origin/main,
with a clean working tree. Read the operating rules, state, architecture/security/database
conventions, migrations, API structure, package/toolchain and CI configuration before editing.
Stage 2.1 evidence and owner acceptance are preserved with only the two owner-authorized relative-link corrections in
[the historical handoff](completed/stage-2-1-identity.md).

## Implementation and boundaries

Internal apps/api/src/identity primitives separate policy, hashing, sanitized errors,
and Prisma credential persistence. No HTTP wiring or authentication/session behavior.
See [durable password security design](../docs/security/PASSWORD_CREDENTIALS.md).

Policy: 15-128 Unicode code points; no composition requirements, trimming, normalization,
case folding or truncation. Spaces are preserved; lone surrogates and non-strings rejected.
Argon2id argon2@0.45.1: version 19, 65536 KiB (64 MiB), 3 iterations, 1 lane,
32-byte output, library-generated random 16-byte salts. No production cost injection.
Verification returns matches/needsRehash; operational failures have fixed safe codes.
No original errors/causes or credential material escape. Native prebuild installed on
Windows Node 24.16.0. Linux supported upstream; hosted Stage 2.2 verification is pending.
The narrow allowBuilds addition was reviewed against the risk register; existing
advisory reachability and dispositions are unchanged.

Creation uses the existing FK and unique userId constraint, returning only non-secret
metadata. Replacement performs compare-and-swap against the old hash/timestamp, and
advances passwordChangedAt at least one millisecond. No schema or migration changes.
No login, routes, session issuance/validation, cookies, JWT, recovery, email behavior,
tenants, membership, roles, permissions, UI, pepper, history or external breach service.

## Tests and performance

Focused password unit tests: 15 PASS. Focused real-database integration tests: 8 PASS.
Unit coverage: policy boundaries, types, Unicode and whitespace, exact production costs,
random salts, correct/wrong candidates, corrupt hashes/resource bounds, rehash and output
length evolution, and sanitized database errors. Integration coverage: hash-only creation,
FK/nonexistent user, concurrent duplicate creation, policy rejection without writes,
replacement/new-versus-old verification, advancing timestamps, missing credentials,
unchanged state after invalid replacement, and deterministic concurrent replacement.
Tests use existing TEST_DATABASE_URL guards and never fall back to DATABASE_URL.
Synthetic candidates are generated at runtime; no secret snapshots or fixture files.

Local single-operation measurement: hash approximately 181 ms, verify 189 ms, at
64 MiB / 3 iterations / 1 lane. Informational, not a CI performance assertion.

## Validation

- Frozen install: PASS, updated lockfile resolves without modification.
- Prisma generation: PASS; accepted schema and all three migrations unchanged.
- Lint: PASS. Typecheck: PASS (11 tasks; unchanged workspaces used Turbo cache).
- Unit/toolchain: PASS, 62 total (61 Vitest plus 1 Node); 24 API tests include 15 new.
- Build: PASS, 7 build tasks; applicable unchanged outputs used existing cache.
- Integration: PASS, 51 total (35 database, 8 Redis, 8 credential), zero skipped.
- Smoke: PASS, 16 assertions with existing PostgreSQL/Redis reachable.
- Formatting: PASS; final aggregate pnpm check: PASS with applicable Turbo caches.
- Mobile check/export: PASS; Android export contains 578 modules.
- Final diff check and security/state review: PASS; no schema, migration, CI or Turbo changes.
- Pre-install, post-install and final audits: EXPECTED FAIL, exactly two known high advisories;
  node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. Nothing suppressed.

Initial focused testing caught the pinned library's m,p,t PHC serialization order;
the defensive envelope and parameter assertion were corrected and all focused tests rerun.
Initial compilation found the existing Prisma namespace export is type-only and the TS
library target omits String.isWellFormed; the service now maps safe error codes structurally
and rejects lone surrogates via Unicode-aware matching. No compiler/schema change.

## Known follow-ups and handoff

Preserve the two accepted advisories, scoped Stage 1 Prisma overrides, concurrent Prisma
generation EEXIST, Actions Node 20-to-24 warning, Ubuntu runner migration, native/store and
non-amd64 validation, existing infrastructure/toolchain issues, and InfrastructureProbe
retirement via a future forward migration. No follow-up is resolved by this task.
Stage 2.2 follow-up: hosted Linux/native installation verification after owner review;
review concurrency capacity and verification compatibility when changing password policy/costs.

All work remains uncommitted. Do not commit, push, deploy, or start Stage 2.3.
Exact next action: owner reviews Stage 2.2 implementation and diff.

## Changed files

- PROJECT_STATE.md
- apps/api/package.json
- apps/api/src/identity/password-credential.service.ts
- apps/api/src/identity/password-error.ts
- apps/api/src/identity/password-hasher.ts
- apps/api/src/identity/password-policy.ts
- apps/api/tests/password.integration.test.mjs
- apps/api/tests/password.test.mjs
- apps/api/vitest.config.ts
- apps/api/vitest.integration.config.ts
- docs/security/PASSWORD_CREDENTIALS.md
- pnpm-lock.yaml
- pnpm-workspace.yaml
- project-state.json
- tasks/CURRENT.md
- tasks/ROADMAP.md
- tasks/completed/stage-2-1-identity.md

No files deleted. Git HEAD remains the starting baseline; nothing staged, committed, pushed, or deployed.

## Final review and commit authorization

The owner authorized repairing the two archived Markdown links, final validation, committing the reviewed Stage 2.2 files as `feat: add password credential service`, and pushing main normally if all checks pass. Both link targets exist and all relative Markdown links in changed documentation/state files resolve. Production Argon2 costs are unchanged and frozen; additional malformed/excessive-cost probes passed without emitting credential material. No schema, migration, logging, HTTP authentication, or tenant/RBAC expansion. The refreshed audit contains only the two accepted high advisories. This authorization supersedes the earlier uncommitted-review checkpoint instructions above. Record actual hosted results afterward and leave those state updates uncommitted; no second documentation commit, amendment, force push, deployment, or Stage 2.3 work is authorized.

Final closure validation rerun: focused unit tests 15 PASS; pnpm check PASS (formatting, lint, typecheck, 62 unit/toolchain tests and seven build tasks); integration 51 PASS, including eight credential cases and atomic replacement race; diff check PASS. The first sandboxed smoke attempt passed 15 assertions then timed out fetching the Control route; inspection found no remaining run-owned processes and the unchanged suite rerun outside the sandbox passed all 16. No timeout or security guard was weakened. Final audit remains exactly two accepted high findings.

## Stage 2.2 hosted verification complete - 2026-10-08

Implementation commit `cdf0ecd62565e9f1a0c0b701263e36c2e9092920` (`feat: add password credential service`) was pushed normally to origin/main. Exactly 17 reviewed files were committed, including the two repaired archive links. No amendment, force push, deployment, or second documentation commit.

[Hosted run 37725238380](https://github.com/ubaliringim/tsms/actions/runs/37725238380) completed for this exact SHA. `validate` PASS (1m38s): 62 unit/toolchain tests, 51 integration tests (35 database, eight Redis, eight credential), 16 smoke assertions; production Argon2id tests and Linux native installation PASS, Prisma generation and migration replay PASS, mobile check/export PASS, tracked-file cleanliness PASS. `security-audit` EXPECTED FAIL (24s), exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm, both high. No new advisory, suppression, or resolution. No other jobs. Overall workflow failure is solely the expected audit gate. Node 20-to-24 and Ubuntu migration notices remain. The concurrent Prisma generation follow-up remains open.

Evidence: gh run view job JSON and complete logs (ignored artifacts/stage22/hosted-run.log). Working tree was clean after pushing, and local HEAD/origin/main matched the implementation SHA. This post-run handoff updates PROJECT_STATE.md, project-state.json, tasks/CURRENT.md, and docs/security/PASSWORD_CREDENTIALS.md only; the owner has now accepted Stage 2.2 and authorized this documentation closure commit. These completed results supersede the earlier pending/uncommitted implementation checkpoint above. Hosted Linux verification is now complete; future target portability and existing infrastructure/toolchain/native/store follow-ups remain.

Stage 1 remains ACCEPTED; Stage 2.1 remains ACCEPTED / HOSTED VERIFIED / CLOSED. Stage 2.2 is ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08). Stage 2 overall is NOT ACCEPTED. Exact next action: hard stop after this authorized documentation closure commit and normal push. **HARD STOP: Stage 2.3 is NOT STARTED / UNAUTHORIZED. Do not begin Stage 2.3 or deploy.**

Final documentation closure: the owner accepted Stage 2.2 and authorized committing only PROJECT_STATE.md, project-state.json, tasks/CURRENT.md, and docs/security/PASSWORD_CREDENTIALS.md with subject `docs: close Stage 2.2 hosted validation`, then pushing main normally. This supersedes the earlier pending-review/no-documentation-commit checkpoint above. All implementation, hosted evidence, unresolved advisories, and existing follow-ups remain unchanged. Stage 1 ACCEPTED; Stage 2.1 and 2.2 ACCEPTED / HOSTED VERIFIED / CLOSED; Stage 2 overall NOT ACCEPTED; Stage 2.3 NOT STARTED / UNAUTHORIZED. Validate formatting, state consistency and diff before commit; verify synchronization and clean working tree after push.
