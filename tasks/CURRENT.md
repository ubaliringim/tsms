# Current task: Stage 2.6 - Rate Limiting and Abuse Protection (HARDENING REVIEW APPLIED)

Owner: TeamStack Technologies LTD

Stage 0 and Stage 1: ACCEPTED. Stages 2.1, 2.2, 2.3, 2.4 and 2.5: ACCEPTED / HOSTED VERIFIED /
CLOSED.
**Stage 2.6: LOCALLY VALIDATED / AWAITING OWNER REVIEW.**
Stage 2 overall: NOT ACCEPTED. Stage 2.7 and later: NOT STARTED / UNAUTHORIZED.

## Starting state

Work started on main at `fd2a58ef30a8f3b32c2c6a587e4e4f93726143a2`
(`docs: close Prisma generation race follow-up`), matching origin/main with a clean working tree. The
Prisma generation race maintenance task was RESOLVED and CLOSED immediately before this stage, and its
history is preserved in `project-state.json` under `resolvedFollowUps` and in
`docs/architecture/DEPENDENCY_REVIEW.md`.

## Authorization

The owner authorized investigation, design, implementation, testing, and documentation of **Stage 2.6
only**, with an explicit instruction not to commit, push, or deploy. Nothing has been committed, nothing
has been pushed, and no deployment occurred.

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

Branch `main` at baseline `fd2a58ef30a8f3b32c2c6a587e4e4f93726143a2`, matching origin/main. Nothing
staged, nothing committed, nothing pushed, no deployment. Recommended commit subject for owner use:
`feat: add distributed authentication abuse protection`. **It has not been created.**

Exact next action: owner review.

**HARD STOP: no commit, no push, no deployment, and no Stage 2.7 without explicit owner authorization.**
