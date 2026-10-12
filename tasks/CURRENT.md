# Current task: Stage 2.8 - Minimal Web Authentication Integration (IMPLEMENTATION COMMITTED / HOSTED VERIFICATION PENDING)

Owner: TeamStack Technologies LTD

Stages 2.1 through 2.7: ACCEPTED / HOSTED VERIFIED / CLOSED. **Stage 2.8: IMPLEMENTATION COMMITTED / HOSTED VERIFICATION PENDING** (not accepted, not closed).
Stage 2 overall: NOT ACCEPTED. Stage 2.9: NOT STARTED / UNAUTHORIZED. Production deployment: NOT AUTHORIZED.

## Stage 2.8 status

Authorized: implementation, local validation, one implementation commit, a normal push to origin/main, and reading the hosted run.
Baseline `a994dfe174d192e85e1f21dc516e84145c0cf13c`. **Committed and pushed for hosted verification; the hosted result is not
recorded here yet; not closed; not deployed.** `apps/api/probe.txt` remains untracked, untouched and excluded.

**Design:** a same-origin proxy (Next route handlers for `login`, `me`, `logout`) rather than credentialed CORS. The API, its cookie, its
Origin allowlist, rate limits, events and migrations are unchanged. The browser Origin is forwarded verbatim; the web origin must be in
`API_TRUSTED_ORIGINS`. Server-only setting `TSMS_API_ORIGIN` (required in production, fails closed, https unless loopback).
Owner-approved corrections applied: streaming byte-counted request limit (4 KiB) and per-route response caps; no cookie forwarded on login;
a session `Set-Cookie` outside the accepted contract is refused; a real-browser suite; a partial CSP. Full specification:
[docs/security/WEB_AUTHENTICATION.md](../docs/security/WEB_AUTHENTICATION.md).

**DEPLOYMENT BLOCKER (unresolved):** behind this proxy all browsers share one API source address, collapsing the Stage 2.6 per-source
limits into one shared budget. Stage 2.6 attribution and limits were deliberately **not** changed. Production topology is unknown.

**Validation (actual outcomes):**

- pnpm install --frozen-lockfile: pass
- pnpm db:generate: pass
- pnpm format:check: pass
- pnpm lint: pass
- pnpm typecheck: pass
- pnpm test: pass, 401 tests: config 37, redis 4, database 17, web 109, worker 4, api 229, toolchain 1
- pnpm build: pass
- pnpm check: pass
- pnpm test:integration: pass, 407 tests: redis 66, database 35, api 281, web 25
- pnpm smoke: pass, 23 assertions
- pnpm mobile:check: pass
- pnpm mobile:export: pass, 578 modules
- pnpm test:e2e: pass, 16 tests in a real installed Google Chrome (E2E_BROWSER_CHANNEL=chrome), on its own Redis logical database
- git diff --check: pass
- pnpm audit --audit-level=high: FAILS as expected, 2 high findings, exactly GHSA-86w9-cpqp-85rv and GHSA-vfj7-8cjw-p6xm
- Negative controls: 7 proxy mutations (request limit off, bytes counted as characters, Content-Length ignored, response cap removed, login forwards cookie, Origin laundered, cookie contract off) each failed tests (11, 1, 1, 5, 2, 2, 1) and the file was restored byte-for-byte

**Incidents during validation:**

- The C: drive was at 100% (about 200-270 MB free) during part of this work. Intermittent failures occurred in that state and did not reproduce in the final full run: a V8 out-of-memory crash (exit 134) in one pnpm test, 4 Argon2id HASH_FAILURE unit failures in one pnpm test (3 isolated reruns and a full rerun passed), and a vitest worker exit 0x80000003. The cause is attributed to low disk and virtual memory, and is not proven.
- Playwright bundled Chromium could not be downloaded (ENOSPC) and was not installed. A Playwright install attempt also removed older cached browser builds from the user-level %LOCALAPPDATA%\ms-playwright cache; they are re-downloadable.
- The web integration suite once ran concurrently with the API suite and reset the shared limiter, failing two API rate-limit tests; fixed by turbo ordering. mobile:check once failed on a network ECONNRESET and passed on retry.
- Free space after the final validation run was about 245 MB on C:.

**Changed files:**

- `.env.example`
- `turbo.json`
- `pnpm-lock.yaml`
- `scripts/smoke.mjs`
- `apps/web/package.json`
- `apps/web/next.config.ts`
- `apps/web/app/globals.css`
- `apps/web/app/page.tsx`
- `apps/web/app/login-form.tsx`
- `apps/web/app/session-gate.tsx`
- `apps/web/app/api/auth/login/route.ts`
- `apps/web/app/api/auth/me/route.ts`
- `apps/web/app/api/auth/logout/route.ts`
- `apps/web/src/server/api-origin.ts`
- `apps/web/src/server/auth-proxy.ts`
- `apps/web/src/client/auth-client.ts`
- `apps/web/src/client/session-state.ts`
- `apps/web/vitest.config.ts`
- `apps/web/vitest.integration.config.ts`
- `apps/web/tests/api-origin.test.ts`
- `apps/web/tests/auth-proxy.test.ts`
- `apps/web/tests/auth-client.test.ts`
- `apps/web/tests/session-state.test.ts`
- `apps/web/tests/interface.test.tsx`
- `apps/web/tests/web-auth.integration.test.mjs`
- `docs/security/WEB_AUTHENTICATION.md`
- `docs/security/AUTH_API.md`
- `PROJECT_STATE.md`
- `project-state.json`
- `tasks/CURRENT.md`
- `tasks/ROADMAP.md`
- `package.json (root: test:e2e script)`
- `.gitignore (Playwright output)`
- `eslint.config.mjs (browser globals for e2e callbacks)`
- `apps/web/playwright.config.mjs`
- `apps/web/e2e/global-setup.mjs`
- `apps/web/e2e/fixtures.mjs`
- `apps/web/e2e/auth.spec.mjs`
- `apps/web/tests/auth-proxy-limits.test.ts`

**Remaining risks:**

1. DEPLOYMENT BLOCKER (unresolved, owner decision): behind the proxy every browser shares one API source address, so the Stage 2.6 per-source meters collapse into one budget for all users. No trusted-proxy CIDR, forwarded-header trust, signed client-IP assertion, or limit change was made.
2. Production topology is unknown and unproven; nothing has run on a real host, behind real TLS, or on a real domain. A non-loopback API origin must use HTTPS (enforced).
3. The CSP is PARTIAL (object-src, base-uri, frame-ancestors, form-action, connect-src). It has no default-src, script-src or style-src and is not an XSS defence. A script-restricting CSP needs per-request nonces (every page dynamically rendered) or fragile post-build hashing; owner decision required.
4. The browser suite runs in Google Chrome only, over loopback HTTP, locally; it is not in CI. The Secure / __Host- production cookie in a browser, other browsers, TLS and hosted ingress still need a hosted HTTPS verification.
5. After an oversized or abandoned request body Node will not serve another request on that keep-alive socket until it closes; the server stays responsive on new connections (tested).
6. No idle session-expiry timer; no double-submit CSRF token; Stage 2.6 and 2.7 limitations remain.
7. node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm remain open and unsuppressed.
8. The development machine had critically low disk space; local results should be re-confirmed on a hosted run.

**Exact next action:** read the hosted run, then await the owner documentation-closure decision, the proxy client-identity decision, and the CSP decision. **DO NOT** create a closure commit, deploy,
begin Stage 2.9, add registration, membership or RBAC, change an accepted Stage 2.1-2.7 contract, delete historical test rows, or touch
`apps/api/probe.txt` without explicit owner authorization.

---

_The remainder of this file is the Stage 2.7 record, kept as history. Where it says Stage 2.8 is unauthorized, the section above supersedes it._

## Closure record

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

_Everything below this record was written before closure. Where it says "locally validated", "under review", or "pending", this
record supersedes it._

## Authorization

The owner authorized **Stage 2.7 implementation and local validation only**. Committing, pushing,
deploying, and Stage 2.8 all remain unauthorized.

## Contract

[docs/security/SECURITY_EVENTS.md](../docs/security/SECURITY_EVENTS.md) is the full specification: event
taxonomy and exact semantics, transaction boundaries and failure policies, the metadata allowlist,
event-volume controls, error sanitization, correlation, failure modes, privacy and retention requirements,
and known limitations.

## Schema

**No schema or migration change.** The accepted Stage 2.1 `AuthenticationEvent` model is reused unchanged.
Its four writable columns and absent metadata column are what make the privacy allowlist structural rather
than procedural.

**Escalated for owner decision:** rate-limit denials, Redis unavailability, Argon2id admission refusals, and
rejected recovery tokens have no representable `AuthenticationEventType`. They are recorded as throttled,
sanitized log lines instead. Making them queryable alongside events requires an enum migration.

## Events written

| Event                      | Coupling              | Notes                                                                       |
| -------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `LOGIN_SUCCEEDED`          | Transaction-coupled   | Written inside the login transaction after the session insert; fail-closed. |
| `LOGIN_FAILED`             | Detached, best-effort | Never changes the response, preserving the accepted enumeration boundary.   |
| `LOGOUT`                   | Transaction-coupled   | Only when a live session was actually revoked.                              |
| `SESSION_REVOKED`          | Transaction-coupled   | One row per session the reset actually revoked.                             |
| `PASSWORD_RESET_REQUESTED` | Transaction-coupled   | Third statement of the token-issuing batch.                                 |
| `PASSWORD_RESET_COMPLETED` | Transaction-coupled   | Written on the reset transaction; fail-closed.                              |

`ACCOUNT_DISABLED`, `PASSWORD_CHANGED`, and `EMAIL_VERIFIED` are deliberately unused - each describes an
action no code performs.

## Volume

The earlier claim that stored events are "inherently bounded" by Stage 2.6 was checked and is only partly
true. Every login-path row is bounded by the global Argon2id budget (120 / min fleet-wide), because a login
that writes an event spent a unit of it. **`LOGIN_SUCCEEDED` has no per-account bound**, since successes are
refunded by design. **`SESSION_REVOKED` fans out** to the user's live session count, which has no cap and a
7-day lifetime. Logout, refused requests, outages, and denials write no unbounded rows. Log lines are
throttled to two per key per five-second window **per process**. Full analysis: SECURITY_EVENTS.md section 9.

## Defects found and fixed during this stage

1. **Silent startup abort.** The abuse guard imported `SecurityLog` type-only, so Nest's design metadata
   recorded `Function`. With `logger: false` and `abortOnError` calling `process.abort()`, the API died
   with no output at all. Fixed with a value import.
2. **A false green.** Integration tests ran against a stale `dist` and reported 239 passing while none of
   the new code was loaded. After rebuilding, real failures appeared. This is a pre-existing property of
   running the package-level integration command directly.
3. **Teardown ordering.** Test teardowns deleted users before their event rows, and the accepted
   `ON DELETE RESTRICT` rejected that - proving the accepted constraint now does real work.

### Found and fixed in the takeover review

4. **`SESSION_REVOKED` double reporting.** The reset counted sessions with a read taken before the update;
   logout takes no lock, so a session it revoked in between was reported by both. The count now comes from the
   update itself. A control restoring the old read fails the interleaving test (3 reported, 2 revoked).
5. **Silent startup abort, still latent.** The first fix only repaired one import. `abortOnError` stayed
   `true` with logging off, so the next injection mistake would abort silently again. Startup now rejects, and
   the message is allowlisted so a driver error cannot print a connection secret.
6. **A second `SecurityLog` in the exception filter**, so the documented throttle bound was not shared.
7. **A disabled-during-login refusal wrote no `LOGIN_FAILED`**, and a token rejected inside the reset
   transaction was not logged.
8. **`PASSWORD_RESET_REQUESTED` bypassed the sanitising row builder**, while the specification said it did not.
9. **A stale-`dist` hazard with no guard**, and two orphaned compiled files. A global setup now refuses stale,
   missing, or orphaned output in both vitest configs.
10. **Test leaks and vacuous assertions.** The accepted `rate-limit-concurrency` suite never removed its users;
    null-user events matched no cleanup; several assertions were satisfied by any row in the table.

## Negative controls

Each was run, observed to fail, then reverted and re-verified.

| Control                                             | Result                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `LOGIN_SUCCEEDED` moved out of its transaction      | Coupling test fails; login succeeded with no audit record.   |
| `SESSION_REVOKED` counted by a pre-read             | Interleaving test fails: 3 reported, 2 revoked.              |
| Log allowlist turned into a pass-through            | 3 sanitisation tests fail.                                   |
| Guard's `SecurityLog` import made type-only         | 2 DI tests fail; a real boot rejects with a legible message. |
| `src` edited, vitest run directly without a rebuild | Both configs refuse to start and say how to rebuild.         |

An earlier coupling test rolled back _before_ the event write and passed under the first control; it was
replaced by one that fails the audit write itself.

## Local validation (Claude Code takeover, 2026-10-11)

| Gate                             | Result                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | PASS; lockfile unchanged                                                                 |
| `pnpm db:generate`               | PASS                                                                                     |
| `pnpm format:check` / `lint`     | PASS / PASS                                                                              |
| `pnpm typecheck`                 | PASS (12 tasks)                                                                          |
| `pnpm test`                      | PASS - **292**: config 37, redis 4, database 17, worker 4, **api 229**, toolchain 1      |
| `pnpm build` / `pnpm check`      | PASS / PASS                                                                              |
| `pnpm test:integration`          | PASS - **382**: redis 66, database 35, **api 281**; none skipped; 0 pending migrations   |
| `pnpm smoke`                     | PASS - 22 assertions                                                                     |
| `pnpm mobile:check` / `export`   | PASS / PASS (Android, 578 modules)                                                       |
| `git diff --check`               | PASS                                                                                     |
| `pnpm audit --audit-level=high`  | **EXPECTED FAIL**: exactly node-forge GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm |

The integration run used a freshly rebuilt `dist` and the stale-build guard was active. Hosted CI: **not run**.
The `tsms_test` row counts were identical before and after the run (581 users, 572 events, 0 orphan events).

## Final design review - 2026-10-11

Owner decisions: log-only for rate-limit, Redis, Argon2id and rejected-token outcomes **approved**;
migration, per-user session cap, aggregate `SESSION_REVOKED` row, deleting test rows, and removing
`apps/api/probe.txt` **not approved**; commit, push, deployment and Stage 2.8 **not authorised**.

- **`SESSION_REVOKED`** is one truthful row per session a reset revoked. The original per-row write failed
  closed at about 20,000 live sessions (Prisma `P2028`); **it is now corrected by one set-based statement**
  (see the fan-out correction below). Semantics, schema and taxonomy are unchanged.
- **Detached `LOGIN_FAILED`**: `detached` could reject on an invalid event type (row built outside its `try`).
  Fixed; five new unit tests, two of which fail on the old code (control run).
- **Stale-build guard**: messages now use forward slashes on every platform; two tests added. Linux CI not run.
- **Logging**: one shared `SecurityLog`; log lines are documented as non-durable and not audit events;
  production needs retention, centralised collection, restricted access and alerting (15.5).
- **Test database**: the 581 historical users were not touched. One failed run under load left **one user and
  six events**; a scoped delete was declined, so `tsms_test` holds 582 users and 578 events.

### Final validation (this review)

`install --frozen-lockfile`, `db:generate`, `format:check`, `lint`, `typecheck`, `build`, `check`: PASS.
`pnpm test`: **292** (api 229, up from 222). `pnpm test:integration`: **375** (redis 66, database 35, api 274) before the fan-out correction,
none skipped; **one earlier run in this review failed** (a 30 s timeout in `rate-limit-hardening` under load,
passing 3 of 3 in isolation and on the full rerun). `pnpm smoke`: 22. `mobile:check`/`export`: PASS, 578
modules. `git diff --check`: PASS. `pnpm audit --audit-level=high`: expected fail, exactly the two accepted
advisories. Hosted CI: not run.

## Fan-out correction - 2026-10-12

Owner authorised a narrow correction for the `SESSION_REVOKED` fan-out and the test-lifecycle defects.
Implementation and local validation, now committed for hosted verification; **not deployed**.

- **Root cause:** one event row per session, written from the application inside Prisma's 5 s interactive
  transaction, so a reset failed closed (`P2028`) above about 20,000 live sessions.
- **Correction:** `SecurityEventRecorder.revokeLiveSessionsRecordingEvents`: one statement,
  `UPDATE ... RETURNING` feeding `INSERT ... SELECT`, on the reset transaction. Exactly one event per session
  that statement revoked; no pre-read; fail-closed; no schema change.
- **UUIDv7:** PostgreSQL 17.11 has no `uuidv7()`. The id is built in SQL to RFC 9562 (millisecond timestamp,
  version 7, RFC variant, `gen_random_uuid()` randomness; PostgreSQL 13+). Verified by tests; swapping in a v4
  fails the test.
- **Benchmarks (3 trials to 50,000, 2 above):** ok through 100,000 live sessions (median 0.33 s at 1,000,
  1.2 s at 20,000, 4.2 s at 50,000, 3.9 s at 100,000); fails at 150,000. Marginal from 50,000. The accepted
  revoke-only baseline fails between 100,000 and 200,000. Memory growth at most 1.8 MiB.
- **Tests:** 7 new integration tests plus 2 replaced (35 to 42): UUIDv7 ids and exact timestamp, 25,000-session
  fan-out, reset vs a revocation interleaved before the statement, **reset vs a real logout holding the row
  (synchronised on a database lock wait, not a sleep)**, rollback when the set-based statement fails, rollback
  of an already-run revocation when the completion event fails, concurrent resets, no event for revoked or
  expired sessions, other users untouched. **Controls:** reverting to pre-read counting fails three tests;
  a UUIDv4 fails one.
- **Test lifecycle:** `settleRequests()` (setup file `track-requests.mjs`) refuses new requests and waits for
  in-flight ones before any teardown deletes rows, closing the leak that left a user and six events.
- **30 s timeout:** not reproduced in 14 further runs (3.6 to 5.2 s); observed twice only on the first run after
  heavy activity, with 1.0 of 15.8 GiB host memory free. Probable host contention, **unproven**. No timeout raised.
- **Remaining:** a reset is still one transaction and still fails closed near 100,000+ live sessions; no
  session cap (not approved). Details: SECURITY_EVENTS.md section 16.
- The historical 581 users, the residual user with six events, and `apps/api/probe.txt` were **not** touched.

### Validation after the correction (2026-10-12)

`install --frozen-lockfile`, `db:generate`, `format:check`, `lint`, `typecheck`, `build`, `check`: PASS.
`pnpm test`: **292** (config 37, redis 4, database 17, worker 4, api 229, toolchain 1; unchanged).
`pnpm test:integration`: **382** (redis 66, database 35, **api 281**), none skipped, passing on the first full
run after the correction (the earlier stalls were before it). `pnpm smoke`: 22. `mobile:check`/`export`: PASS,
578 modules. `git diff --check`: PASS. `pnpm audit --audit-level=high`: expected fail, exactly node-forge
GHSA-86w9-cpqp-85rv and braces GHSA-vfj7-8cjw-p6xm. Hosted CI: not run. `tsms_test` counts unchanged at 582
users, 578 events.

### Unresolved risks preserved at the implementation commit

The owner accepted Stage 2.7 locally for an implementation commit and hosted verification. The following are
**not resolved**, and the first is accepted only provisionally for development, **not for production
readiness**:

1. **Password reset still fails closed at sufficiently large live-session counts.** A reset is one
   transaction under Prisma's 5 s default. On the reference machine it succeeded through 100,000 sessions and
   failed at 150,000, with a marginal region from 50,000. **The 100,000-session measurement is an observation
   on one machine, not a production guarantee.** No per-user session cap exists.
2. **`SESSION_REVOKED` still writes one event row per revoked session.**
3. **`LOGIN_SUCCEEDED` has no per-account event-volume bound**, only the global Argon2id budget.
4. **Structured security logs are non-durable and throttled per process**, and are not audit events.
5. **Log retention, centralised collection, access control and alerting** are production prerequisites that
   this stage does not provide.
6. **Event-table retention and read access are undefined**; no event read API exists.
7. **Test timing varies under host memory pressure.** A 30 s `rate-limit-hardening` timeout was observed twice
   and not reproduced in 14 later runs; the cause is attributed, unproven, to host contention.
8. **Stage 2.6 limitations remain:** Redis as a hard dependency, no approved trusted-proxy model, HMAC secret
   provisioning and rotation, provisional rate-limit thresholds, lease-expiry over-admission, lost refunds,
   untested Redis Cluster, and no production email provider.
9. **Both dependency advisories remain open and unsuppressed:** node-forge `GHSA-86w9-cpqp-85rv` and braces
   `GHSA-vfj7-8cjw-p6xm`. The `security-audit` job is expected to fail on exactly these two.
10. Historical test-database rows (581 users, plus one residual user with six events) were intentionally not
    deleted. `apps/api/probe.txt` is an unexplained untracked file and is excluded from the commit.

## Remaining risks

Rate-limit, outage, and Argon2id outcomes are not queryable in the event table · log throttle state is per
process · log lines are not durable · **`SESSION_REVOKED` fan-out has no per-user session cap** ·
**`LOGIN_SUCCEEDED` is bounded only by the global Argon2id budget** · no event read API · retention
undefined · `LOGIN_FAILED` reveals account existence to table readers, so access control is undefined · no
alerting · all Stage 2.6 limitations persist. **Not production readiness; production deployment remains prohibited.**

Both advisories remain **OPEN**: `node-forge` GHSA-86w9-cpqp-85rv and `braces` GHSA-vfj7-8cjw-p6xm.

## Historical record: Stage 2.6 closure

### Stage 2.6 - Rate Limiting and Abuse Protection - CLOSED

Implementation commit `ca66284fb479a00a2c235ae6e18fa3ec7929b98e`
(`feat: add distributed authentication abuse protection`).

Hosted verification run `38123962717` of the `Stage 1 validation` workflow:
<https://github.com/ubaliringim/tsms/actions/runs/38123962717>

| Item                 | Hosted result                                               |
| -------------------- | ----------------------------------------------------------- |
| `validate` job       | **success**                                                 |
| `security-audit` job | **failure - expected**, exactly the two accepted advisories |
| Overall workflow     | **RED - not green**                                         |

The counts below were read from the hosted run log, not inferred from the local run.

| Measure                  | Hosted value                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| Unit and toolchain tests | 245 (config 37, redis 4, database 17, worker 4, api 182, node toolchain 1) |
| Integration tests        | 340 (redis 66, database 35, api 239)                                       |
| Smoke assertions         | 22                                                                         |
| Migrations               | 3 applied, 0 pending                                                       |
| Mobile export            | Android bundled, 578 modules                                               |
| Unexpected failures      | none                                                                       |

**The overall workflow remains red and is not reported as green.** It is red solely because `security-audit`
fails on the two already accepted advisories, which the owner has directed must not be suppressed,
downgraded, or marked fixed. The `validate` gate - install, generation, check, integration, mobile, and
smoke - passed.

### What Stage 2.6 delivered

- **Atomic multi-dimensional Redis rate limiting.** One Lua script evaluates every dimension of a request
  as a token bucket inside a single indivisible step, so a request is admitted only when every dimension has
  capacity and nothing is written unless every dimension admits. Time comes from Redis `TIME`, never the
  caller, so all instances refill identically despite local clock skew.
- **Reservation and refund.** Admission reserves a token on every metered dimension and the reservation is
  refunded unless the outcome was a credential failure. `AUTHENTICATION_FAILED` and `RECOVERY_TOKEN_INVALID`
  keep the charge; every other outcome refunds it; the global workload budget is never refunded. The refund
  recomputes refill from Redis time and clamps to capacity. It is never an unconditional `INCR`, it cannot
  resurrect an expired key, and it cannot mint budget.
- **Distributed Argon2id semaphore.** At most **8 valid leases** exist across the whole deployment at one
  time, shared by every API instance, enforced immediately before every 64 MiB allocation: login
  verification, login decoy verification, recovery decoy verification, and reset credential hashing.
  Lease 30 s, renewal every 10 s, holder ids are 32 random bytes and never derived from client input.
  Admission is refused immediately, never queued, and never falls back to unlimited admission on Redis
  failure.
- **Trusted transport-peer identity.** The transport peer is the only trusted client identity. `trust proxy`
  remains disabled and not configurable.
- **Fail-closed authentication.** When Redis is unreachable, login, forgot, and reset are refused before any
  Argon2id is attempted and no recovery token is issued. `/auth/me` and logout remain available, and logout
  still revokes through PostgreSQL.
- **Privacy-preserving keys.** Every key is a 32-character HMAC-SHA256 digest in the `{tsms-rl}` namespace. No
  raw credential, address, or Argon2id hash ever reaches Redis.

### Preserved concurrent-bypass evidence

An owner-commissioned review found that the original failure-metered design was a **real concurrent
bypass**, not the "bounded by in-flight concurrency" limitation it had been documented as. Admission was a
check that wrote nothing, with the charge applied after the handler returned, so the two were not atomic.

Demonstrated against real Redis before the fix and preserved in
`apps/api/tests/rate-limit-concurrency.integration.test.mjs`:

| Case                                    | Allowance | Observed before the fix |
| --------------------------------------- | --------- | ----------------------- |
| 20 concurrent failed logins             | 8         | 20 admitted, 0 refused  |
| 20 concurrent invalid resets            | 10        | 20 admitted, 0 refused  |
| The same burst across two API instances | 8         | 20 admitted             |

Sequential traffic correctly refused at the limit, which proved the bypass was concurrency-specific and
distributed. After the fix the same probe admits exactly the allowance.

A negative control confirmed the refund clamp is genuinely tested: removing the ceiling made buckets inflate
to 8 and 12 tokens against a capacity of 5. The source was restored and re-verified clean.

### Stage 2.6 limitations, still open

- **Lease-expiry over-admission.** The semaphore bounds valid leases; it is **not** an unconditional maximum
  of 8 physically running Argon2id operations.
- **Redis is a hard dependency** for login, password recovery, and password reset.
- **Lost refunds** can under-charge a subject.
- **No approved trusted proxy model.** Production use behind a shared TLS-terminating proxy is blocked.
- **HMAC secret provisioning and rotation.** A per-instance value turns a distributed limit into a
  per-instance one; rotation resets every active window and fails open for up to one window.
- **Provisional thresholds**; **Redis Cluster untested**; **production email delivery not configured**.

## Historical authorization record

Work started on main at `fd2a58ef30a8f3b32c2c6a587e4e4f93726143a2`
(`docs: close Prisma generation race follow-up`), matching origin/main with a clean working tree. The
Prisma generation race maintenance task was RESOLVED and CLOSED immediately before this stage, and its
history is preserved in `project-state.json` under `resolvedFollowUps` and in
`docs/architecture/DEPENDENCY_REVIEW.md`.

## Authorization

The owner authorized investigation, design, implementation, testing, and documentation of **Stage 2.6
only**, with an explicit instruction not to commit, push, or deploy. Nothing has been committed, nothing
has been pushed, and no deployment occurred.

**Superseding authorization.** The owner later accepted the local hardening in principle and separately
authorized a final safety review, narrowly necessary Stage 2.6 corrections, and a commit and push of the
implementation for hosted CI verification. That authorization covers the implementation commit
`ca66284` only. It does **not** authorize closing Stage 2.6 documentation, deploying, or beginning
Stage 2.7, and it explicitly forbids amending, force-pushing, or suppressing the two accepted advisories.

## Contract

[docs/security/RATE_LIMITING.md](../docs/security/RATE_LIMITING.md) is the full specification: threat
model, policies, algorithm, key design, outage behaviour, enumeration resistance, operational review,
and residual risk.

| Method | Path                    | Success | New failures                       |
| ------ | ----------------------- | ------- | ---------------------------------- |
| POST   | `/auth/login`           | 200     | 429 limited, 503 limit unavailable |
| POST   | `/auth/password/forgot` | 202     | 429 limited, 503 limit unavailable |
| POST   | `/auth/password/reset`  | 204     | 429 limited, 503 limit unavailable |
| GET    | `/auth/me`              | 200     | 429 limited                        |
| POST   | `/auth/logout`          | 204     | 429 limited                        |

`429` always returns `{ "statusCode": 429, "error": "rate_limited" }` with `Retry-After` in whole
seconds clamped to 1..60, `Cache-Control: no-store`, and `Vary: Origin`. The body does not vary by
dimension. `503` uses the accepted fixed `{ "statusCode": 503, "error": "service_unavailable" }` body,
identical to any other service failure. Every pre-existing status and body is unchanged when a request is
not limited.

## Hardening review - 2026-10-09

An owner-commissioned review investigated two potential weaknesses. **Both were real**, and both had
previously been written up as acceptable limitations, which is what made them worth reviewing.

### Finding 1: concurrent requests bypassed every failure-metered limit

**Root cause.** Admission for a failure-metered endpoint was a _check that wrote nothing_ (`commit: false`),
and the charge happened after the handler returned. Admission and charge were therefore not atomic, so N
simultaneous requests all read the same untouched bucket and all proceeded. The documentation described
this as "bounded by requests in flight", which turned a real bypass into something that read as an accepted
limitation.

**Demonstrated against real Redis, before any fix:**

| Case                                      | Allowance | Observed                   |
| ----------------------------------------- | --------- | -------------------------- |
| 20 concurrent failed logins               | 8         | **20 admitted, 0 refused** |
| 20 concurrent invalid reset attempts      | 10        | **20 admitted, 0 refused** |
| Same burst split across two API instances | 8         | **20 admitted**            |

**Correction: reservation with refund.** Admission now reserves a token on every dimension atomically, so
simultaneous requests contend for real state. The reservation is refunded whenever the outcome was not a
credential failure, which is what keeps a legitimate attempt free. `AUTHENTICATION_FAILED` and
`RECOVERY_TOKEN_INVALID` keep their reservation; the set is exported as `CHARGED_ERROR_CODES` so it cannot
change silently if a handler is refactored. Refund failures are swallowed, because the response is already
produced and losing a refund costs one unit of the caller's own allowance.

**Guarantees now enforced, each asserted against real Redis:**

- A burst of N against a bucket of capacity C admits **at most C**. Login 20 against 8, reset 20 against 10.
- The same holds when the burst is split across **independently created API instances** sharing one Redis.
- Sequential and concurrent traffic are bounded identically.
- Legitimate traffic at or below the allowance is admitted outright and its **full** budget is restored.
- The global verification budget is **never** refunded, because it measures work started.

**Residual:** a refund that cannot be written is lost, so a legitimate attempt is nominally free rather
than provably free under a partial outage. Bounded and self-correcting.

### Finding 2: no bound on simultaneous Argon2id allocations

**Root cause.** A per-minute bucket bounds work _started_, not work _running_. A bucket that starts full hands
out its entire capacity at once, so the 120-token budget permitted a 120-way burst of 64 MiB allocations. No
concurrency bound existed.

**Correction: a deployment-wide leased semaphore**, enforced immediately before every allocation. One Redis
sorted set of lease holders; each member is a 32-byte `randomBytes` id scored by its expiry. Acquire prunes
expired members and refuses at capacity; release removes only that holder and only if present; renew extends
only that holder and only if present.

**Why a Redis lease is safe here:** every endpoint that can reach Argon2id **already** failed closed when
Redis was unreachable, because the rate limiter is consulted first. The admission step therefore introduces
**no new failure mode**.

**Every Argon2id path covered** - real verification, the decoy burn for an unknown or ineligible account,
and reset credential hashing. Both services take the admission service as a **required** constructor
argument, because an optional one could be omitted and silently remove the bound. An eligible recovery
request performs no Argon2id and therefore takes no slot, so legitimate recovery never competes for
verification capacity.

**Failure modes:** crash, `SIGKILL`, and termination all release nothing and the lease expires;
disconnect mid-operation lets the work finish and the release fail silently; delayed, duplicate, and forged
releases are all no-ops and cannot free another's slot; a renewal cannot revive a freed slot; concurrent
acquisition is atomic; Redis unavailability **refuses** admission with no unlimited fallback; malformed
replies and an unreadable clock are refused as unconfirmable. All asserted against real Redis.

**Sizing, and why 8.** 512 MiB of transient allocation fleet-wide, roughly 80 verifications per second
against a measured ~100 ms verification. The bound must sit _above_ the product's legitimate concurrency: the
accepted Stage 2.5 contract includes six concurrent valid logins all being admitted, and an initial capacity
of 4 broke exactly that. A control below legitimate concurrency is the outage, not the protection.

**Residual:** a lease that expires while its work is still running permits bounded over-admission, bounded
by the number of such holders rather than request volume. The lease is 30 s against a ~100 ms operation with
renewal every 10 s, so it needs an event-loop-starved process.

### Secret validation hardened

A length check alone does not establish a secret: `'x'.repeat(32)` satisfies any minimum length and carries
almost no entropy. Startup now also rejects a single repeated character or a short repeating pattern. The
rule is deliberately narrow and is **not** a claim to measure entropy - a legitimate hex-shaped secret, which
is what `crypto.randomBytes(32)` renders as, is explicitly accepted, because rejecting it would push
operators toward weaker values. Sharing across replicas, injection rather than commitment, and never logging
remain operational requirements.

### Four defects found during the hardening

1. **Redis replies to `TIME` with bulk strings**, and the semaphore assumed numbers - so every admission was refused and login and both recovery endpoints returned `503`. Found by an integration run failing every login; the unit test could not have caught it because it supplied the shape the code wrongly expected.
2. **An admission refusal in password reset was reported as a password-policy violation** (`400`) rather than a service failure, conflating two distinguishable outcomes. Found by the existing Stage 2.5 reset suite.
3. **The crash-recovery test passed with the expiry prune removed**, because the key `PEXPIRE` was reclaiming capacity instead of the prune. A test unable to detect its own defect. Found by a deliberate negative control; the test was rewritten to isolate the prune and now fails when it is removed.
4. **The concurrency bound of 4 broke an accepted guarantee**, refusing the excess in the Stage 2.5 suite that asserts six concurrent valid logins succeed. Found by the accepted suite the hardening was required not to weaken.

### Negative controls

- **The bypass itself** - the probe suite recorded the pre-fix behaviour verbatim; after the fix the same probe is bounded.
- **The expiry prune** - removing it left the original test green, proving the test detected the key TTL. After the rewrite, removing it fails the test.
- **The all-or-nothing write rule** - making a refused request write to every dimension fails 3 tests.

### A test-isolation defect found and fixed

Three consecutive full-suite runs exposed intermittent failures in the hardening suites. The cause was
cross-suite interference over state that is **deployment-wide by design**, not a defect in either control.

- The Argon2id semaphore is one key spanning every instance, so it is shared deployment state, not a per-suite fixture.
- `apps/api` and `packages/redis` integration suites run concurrently against the same logical Redis database, and both asserted on that shared key.
- `packages/redis` has an **accepted Stage 1 test that calls `FLUSHDB`** on the test database, deleting the semaphore and the rate-limit buckets out from under `apps/api` mid-run.
- A first attempt excluded the semaphore key from the API suites' cleanup. That fixed the cross-package collision but then left stale holders from earlier suites **within** the same package, because those run sequentially.

**Resolution.** The root `test:integration` script now runs `@tsms/redis` first and every other package
afterwards, so the `FLUSHDB` cannot overlap another suite. The Redis semaphore suite additionally uses its
own key namespace. The API suites reset the full rate-limit namespace, including the semaphore, because
they own it exclusively.

Turbo cannot express a dependency from one package task onto another without also declaring it for every
package, which fails with `depends on itself`; sequencing at the root script is the smallest correct change.

**Not changed:** the `FLUSHDB` assertion is preserved unchanged and still proves a flush is scoped to the
logical database. No production code changed, and the Prisma generation task graph is untouched.

**Verification:** three consecutive full `pnpm test:integration` runs, all green - 52 Redis, 35 database,
239 API.

### Hardening validation

- `pnpm install --frozen-lockfile`: PASS; lockfile unchanged.
- `pnpm db:generate`: PASS; no schema or migration modification.
- `pnpm format:check`: PASS. `pnpm lint`: PASS, zero warnings. `pnpm typecheck`: PASS, 12 tasks.
- `pnpm test`: PASS; **233** unit/toolchain (config 37, Redis 4, database 17, worker 4, API 182 including 61 rate-limit and 24 hardening, plus one Node toolchain test).
- `pnpm build`: PASS, 8 tasks. `pnpm check`: PASS.
- `pnpm test:integration`: PASS; **326** cases (API 239 including 6 concurrency-probe and 30 hardening, Redis 52 including 15 semaphore, database 35), none skipped; 3 migrations applied, 0 pending.
- `pnpm smoke`: PASS; 22 assertions. `pnpm mobile:check`: PASS. `pnpm mobile:export`: PASS, 578 modules. `git diff --check`: PASS.
- `pnpm audit --audit-level=high`: **EXPECTED FAIL**, exactly node-forge `GHSA-86w9-cpqp-85rv` and braces `GHSA-vfj7-8cjw-p6xm`. No new finding, no suppression, threshold unchanged.
- Hosted CI: **NOT RUN**. Nothing committed.

One unrelated observation: a single `pnpm test` invocation failed in the Next.js **control** build because
`/_global-error` exceeded its 60-second budget and was retried. It passed on the following invocation, and no
Stage 2.6 file is involved in that build.

### What the hardening did not change

Argon2id parameters, the password policy, recovery token format and lifetime, reset transaction atomicity,
the session advisory-lock protocol, credential fingerprint revalidation, trusted-origin validation, secure
cookie settings, strict JSON validation, database isolation guards, `no-store` responses, and the Prisma
generation task graph. No schema, migration, dependency, lockfile, or CI change. No CAPTCHA, MFA, public
registration, account lockout columns, or Stage 2.7 event recording.

## Policies

| Endpoint               | Source (per address) | Target (per account / token) | Metered on |
| ---------------------- | -------------------- | ---------------------------- | ---------- |
| login                  | 10 / 5 min           | 8 / 15 min                   | failures   |
| password/forgot        | 5 / 15 min           | 3 / 1 h                      | requests   |
| password/reset         | 10 / 15 min          | 10 / 15 min                  | failures   |
| auth/me                | 120 / 1 min          | none                         | requests   |
| auth/logout            | 30 / 1 min           | none                         | requests   |
| global Argon2id budget | 120 / 1 min          | one key, whole deployment    | requests   |

Conservative development defaults against a measured ~100 ms Argon2id cost at 64 MiB and t=3. Not
industry-standard guidance. Frozen source constants, not environment variables. No account lockout
exists and buckets refill continuously.

**Requests versus failures is a policy decision, not an implementation detail.** `login` and `reset` have
credentials to guess, so charging their successes would let one NAT address lock out colleagues signing
in correctly. `forgot` must be request-metered: email flooding works precisely because each request
succeeds, so a failure-metered control would have limited nothing while appearing to be in place.

## Algorithm

One Redis Lua script in `packages/redis/src/rate-limit.ts`, invoked with `EVAL`, evaluating every
dimension of one request in a single atomic step as a token bucket.

- **All-or-nothing.** Admitted only when every dimension has capacity; **nothing is written unless every
  dimension admits**.
- **Commit versus check.** A `commit: false` dimension is evaluated and contributes to the decision and
  the retry calculation but is not written, which separates pre-flight admission from the post-hoc charge
  for an attempt that turned out to fail.
- **Redis `TIME`**, never the caller, so clock skew cannot change any refill rate.
- **Expiry set by the creating script**, so no crash leaves a key without a TTL. TTL equals the window,
  which is also the time to refill to capacity.
- **`{tsms-rl}` hash tag on every key**, so a multi-key script stays inside one cluster slot.
- Integer refill arithmetic, elapsed time clamped to one window, capacity bounded by validation.

### Guarantees and their limits

Claimed: concurrent requests cannot exceed the allowance; no partial writes; every key expires within one
window; cardinality bounded by distinct subjects in that window; total state sharing across instances.

Not claimed: a concurrent burst of **failures** can overshoot the credential meters, bounded by in-flight
concurrency rather than request volume and never past one window; no strict fairness between dimensions;
**no bound on simultaneous Argon2id verifications**; Redis Cluster designed for but untested; no
constant-time behaviour.

## Trusted client identity

Transport peer address only. `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`,
`True-Client-IP`, `X-Client-IP`, `X-Original-Forwarded-For`, `request.ip`, and `request.hostname` are
all ignored: they are client-supplied unless a proxy strips and rewrites them, and none is deployed.
`trust proxy` is not enabled and is not configurable.

Normalisation collapses IPv4, IPv4-mapped IPv6 (`::ffff:`), IPv4-compatible IPv6 (`::`), and every RFC
5952 spelling of an IPv6 address onto one bucket. Scoped addresses (`fe80::1%eth0`) are rejected; an
unusable or absent peer collapses to a single shared bucket, which is the restrictive direction.

**No claim of individual client identification.** A transport address is a network location. Every device
behind one home, office, campus, or carrier NAT shares a bucket, so one user can exhaust the source
allowance for a site. Per-account and per-target meters are always applied alongside it.

## Key privacy

Format `tsms:rl:v1:{tsms-rl}:<endpoint>:<dimension>:<32 hex chars>` - an HMAC-SHA256 over a
domain-separated message truncated to 128 bits. No raw email address, recovery token, session token,
password hash, or request body becomes key material. The reset target is the token's SHA-256 digest.
Subjects over 512 characters are truncated rather than rejected so response timing does not depend on
submitted length.

`API_RATE_LIMIT_HMAC_SECRET` is required in every environment, 32-512 characters, `[A-Za-z0-9_-]`, and
rejected if it is a known placeholder. It is not authentication material: it authorises nothing, is never
sent to a client, and is never logged. **Every replica must share the value**; a per-instance secret
silently reduces a distributed limit to a per-instance one. Rotation resets every active window and
therefore fails open for up to one window.

## Redis outage behaviour

| Situation                            | login / forgot / reset | me       | logout                      |
| ------------------------------------ | ---------------------- | -------- | --------------------------- |
| Redis unreachable before the request | 503                    | serve    | serve, revoke, clear cookie |
| Redis disconnect during the request  | 503                    | serve    | serve, revoke, clear cookie |
| Redis timeout (750 ms bound)         | 503                    | serve    | serve, revoke, clear cookie |
| Redis command error                  | 503                    | serve    | serve, revoke, clear cookie |
| Malformed / unrecognised Redis reply | 503                    | serve    | serve, revoke, clear cookie |
| Redis recovers                       | enforced immediately   | enforced | enforced                    |

Fail-closed endpoints refuse **before** the handler, so no Argon2id is attempted and no recovery token is
issued while enforcement is unconfirmed. A malformed reply is never treated as permission: only the two
shapes the script produces are acted on. Driver messages are discarded because ioredis can include the
Redis password.

Logout is deliberately not disabled. Revocation is a PostgreSQL write in the accepted Stage 2.3 service;
Redis only ever provided the throttle. An outage therefore leaves revocation working, the cookie still
cleared, and the `204` still a truthful claim. Reporting success while skipping revocation cannot happen:
revocation runs, and a genuine revocation failure surfaces through the accepted `SERVICE_FAILURE` path. A
lost failure charge is likewise swallowed, because the response is already produced and raising it would
turn an ordinary wrong password into a `503`.

No circuit breaker was built; that is outside this stage's scope.

## Argon2id workload protection

A single global token bucket meters Argon2id verifications across the whole deployment at 120 per minute,
charged **before** the handler runs and unconditionally, because an existing and a nonexistent account
both verify by design. Parameters are unchanged at 64 MiB, t=3, p=1, 32-byte digest.

**This is a rate budget, not a concurrency semaphore, and the distinction matters.** It bounds how much
verification work the fleet can be asked to _start_; it does not bound how many run at once. 120 starts
per minute against a 100 ms verification implies roughly 0.2 concurrent, but that is arithmetic, not an
enforced bound. A genuine cap needs leases with expiry and reviewed release semantics, and a half-built
distributed semaphore can deadlock or double-release. **Escalated as the main gap this stage leaves.**

## Enumeration resistance

Target keys derive from the normalised address, identically for existing and nonexistent accounts, with no
database lookup on the key path. Recovery is request-metered specifically so an unknown target is not free.
Known and unknown targets return byte-identical status, body, and headers at every position including the
refusal. A malformed address produces no target dimension but is still metered on source and the global
budget. A malformed token maps to a fixed shared subject. **Not a constant-time claim.**

## Defects found and fixed during implementation

Each was caught by a test rather than by review, and each is recorded in `project-state.json` under
`stage26.defectsFoundAndFixedDuringImplementation`.

1. **IPv6 canonicalisation emitted padded groups.** `2001:db8::1` and `2001:0db8::0001` were treated as
   two different clients with two independent source buckets - a bypass by textual representation alone.
   Groups were padded for arithmetic but never rendered without leading zeros. Fixed, and four spellings
   are now asserted to collapse to one key.
2. **A failure-metered recovery meter would never have limited anything.** Email flooding succeeds, so
   charging only failures left issuance to one victim unlimited while the control appeared to be in
   place. Recovery moved to the request-metered model.
3. **The initial design charged successful logins.** One NAT address could exhaust a budget and lock out
   colleagues signing in correctly - a self-inflicted denial of service. Split into failure-metered
   credential meters plus an unconditionally charged global workload budget.
4. **A malformed recovery token produced no target dimension**, leaving non-canonical guessing unmetered.
   Such tokens now map to a fixed shared subject.

## Tests

**Unit, 61 focused** (`apps/api/tests/rate-limit.test.mjs`): policy validation and per-dimension
uniqueness; key derivation, privacy, single hash tag, endpoint separation, secret sensitivity, determinism,
oversized-subject bounding; IPv4, IPv6, and IPv4-mapped IPv6 normalisation; scoped and malformed address
rejection; transport peer versus eight spoofed forwarding headers; `Retry-After` bounds and rounding;
dimension composition and commit flags; request-versus-failure classification; malformed replies;
connection-detail sanitisation; one-command issuance; failure charging.

**Redis integration, 37** (`packages/redis/tests/rate-limit.integration.test.mjs`), 33 of them new:
exact capacity; **concurrency at the limit boundary - twenty racing requests against five slots are
admitted exactly five times**; multi-dimensional atomicity; no write on refusal; subject isolation;
duplicate-dimension rejection; TTL on first write; refill; key eviction; retry proportionality and
shrinkage; zero wait when admitted; unreachable Redis; bounded timeout; thirteen malformed replies; the two
accepted verdict shapes; error sanitisation; recovery; configuration validation; check-without-charge;
bounded key growth.

**API integration, 32 focused** (`apps/api/tests/rate-limit.integration.test.mjs`) against real Redis and
real PostgreSQL through the real HTTP application: login source and account limits; cross-user isolation;
concurrent burst then refusal; **state shared across two independently created applications**; recovery
source and target limits; cross-target isolation; reset invalid-token and per-token limits; integrity
after refusal (credential unchanged, no token created, original password still works); `Retry-After`
behaviour; Redis-unavailable behaviour on all five endpoints including fail-closed before Argon2id, no
recovery token issued, `/auth/me` still correct, logout still revoking and clearing, readiness degraded,
and recovery once Redis returns; known-versus-unknown equivalence for login and recovery; token validity
never visible; eight spoofed forwarding headers ineffective; no session or credential write after a
refusal; and the preserved Stage 2.4 and Stage 2.5 contracts, origin matrix, body limits, health endpoint,
database isolation guards, and key namespace.

No test sleeps to wait out a window: refill and eviction are observed by polling with a bounded deadline,
so a slow machine makes a test slower rather than flaky.

The pre-existing Stage 2.4 and Stage 2.5 suites reset only the accumulated rate-limit budget in
`beforeEach`, the same hygiene they already applied to their database fixtures, and each uses its own
secret so key spaces cannot collide. The real Redis, the real script, and the real guard run in every one
of those tests.

## Changed accepted files

Stage 2.6 modifies eight previously accepted files, all within the authorized boundary:

1. `apps/api/src/identity/auth.controller.ts` - the `AbuseProtected` decorator, `AuthAbuseGuard`, the
   failure-charge interceptor, and a first-statement refusal check on all five routes. No parsing or
   contract change.
2. `apps/api/src/identity/auth.module.ts` - registers the guard, interceptor, and protection service
   against the existing process-owned Redis client. No second connection.
3. `apps/api/src/identity/auth.service.ts` - adds the `RATE_LIMITED` code only.
4. `apps/api/src/identity/auth-exception.filter.ts` - adds the fixed `429` body.
5. `packages/config/src/env.ts` - adds the validated `API_RATE_LIMIT_HMAC_SECRET`.
6. `packages/redis/src/index.ts` - exports the primitive.
7. `turbo.json` - adds the new variable to `globalEnv`. **No task-graph change; the Stage 1 single-writer
   Prisma graph is preserved.**
8. `scripts/smoke.mjs` and `.env.example` - three startup-failure cases and documentation for the new
   required secret.

Six new source files, two new API test files, one new Redis test file, one test support module, and one
new document (`docs/security/RATE_LIMITING.md`). No schema, migration, dependency, or lockfile change.

## Preserved unchanged

Argon2id parameters; password policy; recovery token entropy, format, and 30-minute expiry; token
single-use and supersession; reset transaction atomicity; the shared per-user advisory lock and in-lock
credential fingerprint revalidation; exact trusted-origin validation and missing-Origin refusal; secure
cookie attributes and duplicate-cookie rejection; the decoy-digest enumeration defence; strict JSON
validation and unknown-key rejection; the 4 KiB body limit; `Cache-Control: no-store` with `Vary: Origin`;
and the database and Redis disposable-test guards.

No credentialed CORS. No registration. No Stage 2.7 `AuthenticationEvent` recording.

## Validation

- `pnpm install --frozen-lockfile`: PASS; lockfile unchanged.
- `pnpm db:generate`: PASS; no schema or migration modification.
- `pnpm format:check`: PASS.
- `pnpm lint`: PASS; zero warnings.
- `pnpm typecheck`: PASS; 12 tasks.
- `pnpm test`: PASS; **208** unit/toolchain tests (config 26, Redis 4, database 17, worker 4, API 157
  including 61 focused Stage 2.6, plus one Node toolchain test).
- `pnpm build`: PASS; 8 build tasks.
- `pnpm check`: PASS.
- `pnpm test:integration`: PASS; **275** cases (API 203 including 32 focused Stage 2.6, Redis 37,
  database 35), none skipped; 3 migrations applied, 0 pending.
- `pnpm smoke`: PASS; **22** assertions, including 3 new startup-failure cases for the required secret.
- `pnpm mobile:check`: PASS. `pnpm mobile:export`: PASS, Android 578 modules.
- `git diff --check`: PASS.
- `pnpm audit --audit-level=high`: **EXPECTED FAIL**, exactly two accepted high advisories (node-forge
  GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm). No new finding, no suppression, threshold unchanged.
- Hosted CI: **NOT RUN**. Nothing committed, so there is no run to trigger.

## Deployment blockers

1. A production `API_RATE_LIMIT_HMAC_SECRET` must be an injected random secret shared by every replica.
2. Redis availability becomes an authentication dependency. `/ready` already reports Redis, so a load
   balancer stops routing before users see errors.
3. No real email provider, so password recovery remains unusable in production regardless of rate
   limiting.
4. Load-balancer policy must be decided: a TLS-terminating proxy collapses all clients onto one source
   bucket.
5. Limits are untuned development values needing review against real traffic and school network topology.

## Escalation for owner decision

- **The Argon2id concurrency bound of 8**, or a different value with its memory implications. The bound now
  exists; its size is a tuning decision against real memory headroom and real traffic.
- **Redis is now a hard dependency for authentication.** Login and both recovery endpoints fail closed
  without it, because neither the rate limiter nor the concurrency bound can be confirmed.
- **Proxy trust is undecided.** Neither client identity nor the trusted-origin allowlist is proxy-aware. A
  TLS-terminating shared proxy collapses every client onto one source bucket, and this stage is **not
  production-ready behind such a proxy**. Resolving this needs an explicit reviewed model naming the hops.
- **The rate-limit key secret as a deployment value:** injected, shared by every replica, never committed,
  never logged. Rotation resets every active window and fails open for up to one window.

## Remaining open risks from earlier stages

Both high-severity advisories remain unresolved, installed, and unsuppressed. No production email
provider. Deferred credentialed CORS and the broader CSRF design. Per-user login serialisation during the
short locked transaction. Advisory-lock coordination covers only participating writers. An IPv6 client
with a large address space can vary its address to obtain fresh source buckets. Secret rotation resets
active windows. Redis Cluster designed for but untested. No circuit breaker. No security-event recording
or alerting on rate-limit decisions. Every previously documented infrastructure, Prisma, CI, and native
platform follow-up is preserved unchanged, as is the resolved Prisma generation race history.

## Git status

Branch `main`, baseline `8442769f4642a3d0dad9735ecb8d7db0628a8479` matching origin/main.

Stage 2.7 was committed as `d898ae907669d21c99132797b0b6ddfbe5078901` (`feat: add authentication security events and sanitization`), pushed to origin/main,
hosted-verified (`validate` success, `security-audit` expected failure, workflow RED) and closed by a documentation-only
commit. The untracked `apps/api/probe.txt` was never staged. **No deployment** has occurred at any point in this stage.

Exact next action: await separate explicit owner authorization. Stage 2.8 is NOT STARTED and is NOT AUTHORIZED; this file
deliberately names no next task. Production deployment is NOT AUTHORIZED.

**HARD STOP: no Stage 2.8 and no deployment without explicit owner authorization.**
