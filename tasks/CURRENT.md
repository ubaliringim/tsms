# Current task: Stage 0 - Engineering Foundation

Task: 0.1 - Repository and engineering foundation

Status: ACCEPTED (owner decision, 2026-10-07)

Stage: 0 - Engineering Foundation

Next planned stage: Stage 1 - Database & Local Infrastructure (implementation NOT yet authorized)

Updated: 2026-10-07

## Required reading

AGENTS.md, PROJECT_STATE.md, docs/product/PRODUCT_SPEC.md, the architecture specifications listed in AGENTS.md, docs/architecture/DEPENDENCY_REVIEW.md, docs/security/DEPENDENCY_RISK_REGISTER.md, ADR-001 through ADR-007, and tasks/ROADMAP.md.

## Stage 0 goal and scope

Establish a reproducible pnpm/Turborepo TypeScript workspace, minimal Next.js web/Control, NestJS API, Expo mobile, worker, shared configuration, meaningful tests, environment validation, CI, durable project memory, and a defensible security disposition for every open dependency advisory.

## Exclusions

No business Prisma schema, authentication/login, tenant onboarding/RBAC, students/teachers/enrollment, curriculum/resources/AI, assessments/mastery/recommendations/gamification/analytics/billing, external data services, or production deployment. Stage 0 acceptance does not change these exclusions.

## Acceptance checklist

- [x] Installation succeeds and lockfile supports frozen installation.
- [x] Workspace dependencies and TypeScript configurations validate.
- [x] Web, Control, API, worker, and shared configuration build.
- [x] Mobile typechecking, SDK compatibility, and Android JavaScript bundling pass.
- [x] Root formatting, lint, typecheck, test, and build pass.
- [x] Environment validation is documented and tested.
- [x] Compiled entry points, health responses, and production placeholder routes verified.
- [x] CI workflow defines relevant gates with read-only repository permissions and no deployment.
- [x] Targeted secret scan and ignored-artifact review found no credentials/private environment/build outputs tracked.
- [x] Product, architecture, database, isolation, security, AI specifications and seven ADRs exist.
- [x] AGENTS, roadmap, and synchronized project/task state exist.
- [x] No future-stage product functionality implemented.
- [x] New files and Git diff reviewed; whitespace check passes.
- [x] Both open advisories have a completed, evidence-backed reachability analysis and a written disposition in docs/security/DEPENDENCY_RISK_REGISTER.md.
- [x] Deployment artifacts confirmed free of node-forge and braces/micromatch code.
- [x] Owner reviewed and accepted both temporary risk dispositions (2026-10-07).
- [x] **Stage 0 reviewed and accepted by owner (2026-10-07). Stage 1 remains closed pending explicit authorization.**
- [ ] Added dependency-security gate: `pnpm audit --audit-level=high` passes. **Still FAILS.** Two open high-severity advisories, neither with a patched release. Accepted under documented non-reachability, not remediated. Tracked as a standing risk.

## Completed implementation

- Initialized Git on main, preserving PROJECT_NOTES.md. Git metadata ownership now matches the user's Windows account; no global trust exception was added.
- Pinned Node 24.16.0/pnpm 12.3.4, exact direct dependencies, pnpm lockfile, strict peer checks, install-script allowlist, and strict review of release-age exceptions.
- Configured Turbo dependency ordering/caching, shared strict TypeScript presets, ESLint/Next rules, Prettier, editor/line-ending rules, and ignore patterns.
- Added minimal Next.js web and Control shells; Expo SDK 57 student shell; NestJS 12 ESM API; independently runnable worker health process.
- Added @tsms/config with server-only Zod parsing; invalid settings fail before listening and expose key names, not supplied values.
- Added meaningful environment, HTTP, and transitive-tool compatibility tests plus reproducible compiled-service smoke checks.
- Added product/architecture documents, ADRs, roadmap, agent rules, state/handoff files, README, and changelog.
- Added Linux GitHub Actions validation workflow; no remote configured, so hosted CI has not run.
- Added docs/security/DEPENDENCY_RISK_REGISTER.md as the canonical per-advisory disposition record; docs/architecture/DEPENDENCY_REVIEW.md points at it instead of restating dispositions.
- Recorded the owner's 2026-10-07 acceptance of both temporary dispositions, with explicit non-resolution statements and audit policy.

## Owner security decisions of record

Both advisories below are **OPEN - TEMPORARILY ACCEPTED WITH DOCUMENTED NON-REACHABILITY**. **Neither is
resolved or remediated.** Both packages remain installed and both vulnerable code paths remain present on
disk. Neither advisory has a patched upstream release.

| Advisory                                                                 | CVE            | Package          | Disposition                                                  | Owner decision      | Resolved |
| ------------------------------------------------------------------------ | -------------- | ---------------- | ------------------------------------------------------------ | ------------------- | -------- |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | CVE-2026-85393 | node-forge 1.4.0 | OPEN - temporarily accepted with documented non-reachability | ACCEPTED 2026-10-07 | **No**   |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | CVE-2026-93687 | braces 3.0.3     | OPEN - temporarily accepted with documented non-reachability | ACCEPTED 2026-10-07 | **No**   |

Decision basis: the existing reachability analysis recorded in docs/security/DEPENDENCY_RISK_REGISTER.md -
enumerated call sites, attacker-controlled-input analysis, deployment-artifact scans, and rejected remediation
options. Full detail, including per-advisory review triggers that void the acceptance, is in the register.

## Audit status and policy

**The technical audit status remains FAILING.** `pnpm audit --audit-level=high` exits non-zero with two
high-severity findings, both reporting `Patched versions: None`. It is not marked as PASS anywhere.

In force and unchanged:

- Neither advisory is suppressed; no `ignoreCves`, no `.npmrc` audit setting, no advisory ignore list.
- The `--audit-level=high` threshold is not lowered.
- No broad ignore rules exist.
- The CI step `pnpm audit --audit-level=high` in `.github/workflows/ci.yml` is unchanged.
- The two accepted findings are dispositioned individually by advisory ID, not by category.
- **New or unreviewed high-severity findings remain unacceptable and blocking.**
- A future security-policy task should add a controlled mechanism separating reviewed temporary exceptions
  from new vulnerabilities while still surfacing the raw audit result and still failing on unreviewed
  findings. **Not built during Stage 0 closure** - no existing Stage 0 mechanism supports it cleanly, and the
  only security gate today is the single unconditional audit step, which correctly fails and should continue
  to do so. That work requires its own authorized task.

## Validation evidence

Stage 0 validation is recorded below as previously executed. Results are not restated as new passes from this
closure task.

Executed on Windows with Node 24.16.0 / pnpm 12.3.4. `pnpm.cmd` is the PowerShell shim used for the commands.
Turbo cache hits reused earlier successful local executions where inputs were unchanged.

| Command/check                          | Result  | Evidence/scope                                                                                                                 |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`       | PASS    | Lockfile accepted with no resolution changes; supply-chain policies verified.                                                  |
| `pnpm format`                          | PASS    | Reformatted the security documents; no source file changed.                                                                    |
| `pnpm format:check`                    | PASS    | All matched files use Prettier formatting.                                                                                     |
| `pnpm lint`                            | PASS    | No errors or warnings under max-warnings=0. Exercises the braces path with static `rootDir` literals and completed normally.   |
| `pnpm typecheck`                       | PASS    | Six workspaces; seven Turbo tasks.                                                                                             |
| `pnpm test`                            | PASS    | 15 tests: 10 config, 2 API, 2 worker, 1 Expo xcode/uuid toolchain. No failures.                                                |
| `pnpm build`                           | PASS    | Five build targets: config, API, worker, web, Control. Mobile native build deliberately absent.                                |
| `pnpm check`                           | PASS    | Aggregate formatting, lint, typecheck, tests, build all succeeded.                                                             |
| `pnpm mobile:check`                    | PASS    | Expo reports dependencies are up to date.                                                                                      |
| `pnpm mobile:export`                   | PASS    | Android Hermes JavaScript export, 578 modules, 1.4 MB. Bundle hash unchanged across sessions.                                  |
| `pnpm smoke`                           | PASS    | **First run FAILED** (see Known issues); four subsequent runs passed all six assertions.                                       |
| `pnpm audit --audit-level=high`        | FAIL    | 2 high findings, both `Patched versions: None`. node-forge 2 paths; braces 53 paths rooted at `.` and `apps/student-mobile`.   |
| `git diff --check`                     | PASS    | No whitespace errors.                                                                                                          |
| Deployment artifact content scan       | PASS    | 0 occurrences of node-forge/braces/micromatch in the Hermes bundle, both `.next` outputs, `apps/api/dist`, `apps/worker/dist`. |
| Production dependency-tree enumeration | PASS    | API, worker, and web prod trees contain no node-forge/braces/micromatch/fast-glob.                                             |
| Hosted GitHub Actions                  | NOT RUN | Workflow exists; no remote/push was performed.                                                                                 |
| Native Android/iOS device/store builds | NOT RUN | Static checks and Android JS export only; no native tooling/signing claim.                                                     |

### Closure-task validation (2026-10-07)

Executed during this closure task:

| Command/check                                 | Result           | Notes                                                                                          |
| --------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `git status --short`                          | PASS             | 80 intent-to-add files; no commits; no remote. Only documentation and state files were edited. |
| `git diff --check`                            | PASS             | No whitespace errors.                                                                          |
| `pnpm format`                                 | PASS             | Applied to the edited Markdown/JSON only. No source file changed.                              |
| `pnpm format:check`                           | PASS             | All matched files use Prettier formatting.                                                     |
| `pnpm lint`                                   | PASS             | No errors or warnings. Documentation edits introduced no lint findings.                        |
| `pnpm audit --audit-level=high`               | FAIL (unchanged) | Still 2 high findings, both with no patched release. Not suppressed, not reclassified.         |
| `pnpm test` / `pnpm build` / `pnpm typecheck` | PASS             | Re-confirmed after documentation edits; no source files were modified.                         |

No behavioural re-validation was required: this task changed documentation and state records only.

### Observed failure: `pnpm smoke` (preserved, not fixed)

The first `pnpm smoke` execution in the analysis session failed:

```
AssertionError [ERR_ASSERTION]: api must fail fast on invalid configuration
null !== 1
    at rejectsInvalidEnvironment (file:///C:/Users/hp/Documents/devs/tsms/scripts/smoke.mjs:62:10)
```

`scripts/smoke.mjs:60` polls with a fixed 10-second deadline for the API child process to exit, then asserts
`exitCode === 1`. The child had not exited within 10 seconds, so `exitCode` was still `null`. This ran
immediately after `pnpm mobile:export`, which starts and stops a Metro bundler on the same host.

Direct and isolation checks behaved correctly: running `apps/api/dist/main.js` with
`API_PORT=private-invalid-value` exits 1 in roughly one second with `Invalid environment configuration:
API_PORT`, and a minimal reproduction of the exact spawn/poll logic exits with code 1 in about one second.
**Four subsequent full `pnpm smoke` runs passed all six assertions**, and no stray Metro/Node processes
remained.

Most likely cause is Windows process-start latency exceeding a hardcoded deadline, not a product defect. Root
cause was not conclusively determined. **The smoke implementation was deliberately not changed during this
closure task.** **Hosted Linux CI has not yet validated this behaviour.** This does not block Stage 0
acceptance.

### Resolved validation failures

Initial typechecking found CommonJS imports incompatible with NestJS 12 ESM; server packages were converted to NodeNext/ESM and checks passed. Expo initially required newer React types than its template listed; all React apps now use 19.2.4 and compatibility/typechecks passed. Initial audit included uuid 7.0.3; the scoped xcode>uuid 11.1.1 override removed that finding and its consumer test passed. Sandbox registry/store/index restrictions required approved elevated tool runs; final commands succeeded except the documented audit gate. An unsupported pnpm CLI flag was removed before installation. `pnpm format` was re-run because two new/edited Markdown files failed `format:check` on first attempt.

## Meaningful tests

Total: 15 passing tests.

- 10 environment cases: safe defaults, configured ports, unknown-key stripping, seven malformed/out-of-range port cases checked for both services, and invalid mode/host plus redaction.
- 2 API HTTP cases: uncached minimal liveness with no powered-by header; unimplemented route returns 404.
- 2 worker HTTP cases: minimal process liveness; unsupported path/method rejection.
- 1 Expo - config-plugins - xcode integration case: the patched uuid dependency still produces valid distinct Xcode identifiers.
- Smoke checks cover actual built entry points and web responses. Health responses prove process liveness only, not database/queue readiness.

## Files and repository structure

80 uncommitted files comprise root tooling/state/agent documents, five apps, packages/config, product and architecture docs, seven ADRs, docs/security risk register, tasks, infrastructure/test strategy notes, CI, smoke script, and lockfile. PROJECT_NOTES.md was preserved. Generated builds, installed dependencies, local env files, Next-generated next-env.d.ts, and `artifacts/` are ignored.

`artifacts/stage0-risk/` holds `pnpm why` evidence and on-disk package locations. It is gitignored and prettierignored, so it is scratch evidence, not a deliverable; reproducible commands are recorded in the risk register instead.

## Known issues and deviations

These remain open and are not represented as completed.

1. **Two unresolved dependency advisories under accepted temporary dispositions.** `pnpm audit --audit-level=high` still exits 1 on node-forge 1.4.0 (GHSA-86w9-cpqp-85rv) and braces 3.0.3 (GHSA-vfj7-8cjw-p6xm). Neither has a patched upstream release. Both packages remain installed with the vulnerable code present. The owner accepted the risk on documented non-reachability on 2026-10-07; **neither advisory is resolved.** See docs/security/DEPENDENCY_RISK_REGISTER.md.
2. **`pnpm smoke` is timing-fragile on Windows.** `scripts/smoke.mjs:60` uses a fixed 10-second deadline for the fail-fast assertion. It failed once immediately after `pnpm mobile:export` and passed four times afterwards. Hosted Linux CI has not validated it. Recommended future hardening: raise the deadline or retry once on a null exit code, and avoid running smoke immediately after a Metro export. Not changed here.
3. **Hosted Linux GitHub Actions has not run.** No remote or push was performed. The workflow is defined but unexecuted in CI.
4. **Native Android/iOS device and store builds have not run.** Static checks and Android JavaScript export only; no native tooling or signing claim.
5. **No controlled audit-exception mechanism exists.** Reviewed temporary exceptions cannot currently be distinguished from new vulnerabilities except by reading the register. Deferred to a future security-policy task; not built during Stage 0 closure.
6. ESLint 9.39.5 is upstream-deprecated but retained because the React lint plugin does not declare ESLint 10 compatibility. Strict peer validation stays enabled.
7. Only packages/config has real shared behavior at this stage; other conceptual packages are deferred as permitted by the specification.
8. API development uses Nest CLI compilation to preserve decorator metadata. Worker uses TypeScript/tsx; no BullMQ connection exists until a later task needs it.

## Security and working tree

No credentials were introduced or found by the targeted review. No commit, remote push, or production deployment was performed. The .env.example contains safe local settings only. Security controls were not removed to make tests pass. No third-party package source was modified, no fork or patched package was introduced, and no advisory, audit threshold, or CI gate was suppressed.

All files remain uncommitted with intent-to-add index entries so `git diff` includes new files. There is no initial commit; `git log` has no history. The working tree is intentionally not clean pending a Stage 0 baseline commit.

## Exact next action and handoff

Stage 0 is accepted. The immediate next action is to create the Stage 0 baseline commit once explicitly authorized. A suggested commit subject is recorded in the closure report; **no commit was created during this task.**

Then await explicit Stage 1 authorization. Stage 1 - Database & Local Infrastructure is the next planned stage, but implementation authorization has NOT been granted and no Stage 1 task is active.

Standing obligations: continue tracking both accepted advisory dispositions; apply upstream fixes when published; re-run the reachability analysis if any register review trigger fires; run Stage 1 preparation only under explicit authorization.

DO NOT start Stage 1 without explicit owner authorization, implement product features, suppress security findings, mark the accepted advisories resolved, weaken isolation/approval rules, overwrite existing work, or deploy to production.
