# Current task: Stage 2.4 - Login, Current User and Logout API

Owner: TeamStack Technologies LTD

Stage 0 and Stage 1: ACCEPTED. Stages 2.1, 2.2 and 2.3: ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2.4: IN PROGRESS / LOCALLY VALIDATED; NOT ACCEPTED, NOT COMMITTED, NOT PUSHED.
Stage 2 overall: NOT ACCEPTED. Stage 2.5 and later: NOT STARTED / UNAUTHORIZED.

## Starting state

Work started on main at 6df160a5cdd161793ce43ad0fae34235c999a84f (`docs: close Stage 2.3 hosted
validation`), matching origin/main with a clean working tree. No prior agent's uncommitted work
existed and none was discarded. Preserved prior handoffs: tasks/completed/stage-0-engineering-foundation.md,
tasks/completed/stage-1-database-and-local-infrastructure.md, tasks/completed/stage-2-1-identity.md,
tasks/completed/stage-2-2-password-credentials.md, and the Stage 1 hosted CI repair.

## API contract

[docs/security/AUTH_API.md](../docs/security/AUTH_API.md) is the accepted-shape reference.
[docs/architecture/SECURITY.md](../docs/architecture/SECURITY.md) records the stage boundary.

| Method | Path           | Success | Failures                                           |
| ------ | -------------- | ------- | -------------------------------------------------- |
| POST   | `/auth/login`  | 200     | 400 malformed, 401 auth, 403 origin, 413 too large |
| GET    | `/auth/me`     | 200     | 401 unauthenticated                                |
| POST   | `/auth/logout` | 204     | 403 origin                                         |

Login accepts `application/json` with exactly `{ email, password }`, both strings, and returns
`{ "user": { id, email, displayName } }`. The opaque token is returned only in `Set-Cookie`.
`/auth/me` returns the same minimal profile from the session cookie. `/auth/logout` revokes the
presented session, clears the cookie, and always answers 204 with an empty body.

Every authentication failure is one fixed body, `{ "statusCode": 401, "error": "authentication_failed" }`,
covering unknown email, wrong password, absent credential, and disabled account identically.

## Architecture and responsibilities

- `auth.service.ts` orders the operations and owns the failure taxonomy. It is HTTP-agnostic.
- `auth.controller.ts` is transport only: JSON content type, strict body shape, cookie I/O.
- `PasswordCredentialService` (Stage 2.2, unchanged) verifies the password.
- `SessionService` (Stage 2.3, unchanged) creates, validates, and revokes the session.
- `DatabaseService` supplies the one process-owned Prisma client; no second connection.
- `trusted-origin.guard.ts` is the CSRF admission check on the two state-changing routes.
- `auth-body-limit.ts` rejects an oversized declared body before parsing.
- `auth-exception.filter.ts` replaces malformed-request and oversized-body errors with fixed bodies.

`api_TRUSTED_ORIGINS` is a new required startup-validated value. It is wired into the config
package, turbo `globalEnv`, `.env.example`, the local `.env`, CI, and the smoke script. It is
required in **every** environment including production: an absent allowlist is a fail-closed API.

## Security decisions

**Origin and CSRF.** Login and logout require an `Origin` matching the allowlist by exact string
equality. No trusted value is derived from `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, or
`Referer`. A missing `Origin` is a 403 rather than a pass: browsers attach `Origin` to every POST,
so requiring it costs real clients nothing while closing the anonymous-client gap. `SameSite=Lax`
and the `Origin` check are defence in depth. `GET /auth/me` is unguarded because it is safe and
requiring `Origin` would break direct navigation.

**Enumeration resistance.** Failed paths run Argon2id against a committed decoy digest with
production parameters (64 MiB, t=3, p=1) so they cost what success costs. The decoy was generated
from a random 32-byte string that is not stored anywhere; it corresponds to no account, and the test
suite confirms it verifies no real test password. This is explicitly **not** a constant-time claim:
`verifyPassword` short-circuits before Argon2 for a policy-invalid candidate (symmetrically on both
paths), database round trips are not equalised, and there is no throttling.

**Cookies.** `__Host-tsms_session` + `Secure` in production; `tsms_session` on loopback HTTP in
development and test. Attributes are derived from validated `NODE_ENV`, so no configuration can
disable `Secure` in production. Always `HttpOnly`, `SameSite=Lax`, `Path=/`, never `Domain`.
`Max-Age` is bounded by the session's own absolute expiry. A duplicated cookie is rejected as
unauthenticated rather than resolved by occurrence order. Cookie values are parsed directly; no
parsing dependency was added.

**Logging and errors.** The bearer secret never enters a body, URL, header other than `Set-Cookie`,
or log. Driver messages, Prisma codes, Argon2id failures, and stack traces are never returned.
Malformed-JSON parser messages, which quote the submitted fragment, are replaced wholesale. The
filter deliberately does not log.

**CORS.** Credentialed CORS is not enabled and no CORS header is emitted, so a browser will not
expose a cross-origin response. The contract is same-origin only; wiring web/control on ports
3000/3001 needs a later explicit allowlist decision.

**Body limit.** 4 KiB, enforced twice: an explicit pre-parse `Content-Length` check for a
deterministic 413, and the adapter parser limit for a chunked or understated body.

## Tests

Focused unit: 37 PASS. Cookie policy derivation per environment, `__Host-` requirement
satisfaction, `Max-Age` bounding and expiry clearing, cookie parsing including duplicate and
quoted-form rejection, exact origin matching with wildcard/suffix/subdomain/forwarded-header
rejection, email normalisation semantics, error body shapes, and origin configuration validation
including the wildcard-host case.

Focused integration: 66 PASS against real PostgreSQL and the real HTTP application. Login success,
cookie attributes, no token in any response surface, digest-only persistence, normalisation, no
password trimming, no session created on any failure, all four failure conditions byte-identical,
ten malformed-body shapes, content-type enforcement, size limit, database-unavailable non-
authentication, current-user resolution and its six rejection cases, logout revocation and
idempotence, per-session revocation isolation, same-user second session survival, cross-user
isolation, origin enforcement across eight disallowed forms, missing-Origin fail-closed, five
spoofed-header attempts, cache headers, absent CORS headers, and a ten-route scope regression.

Both use the guarded `TEST_DATABASE_URL`/`TEST_REDIS_URL` with `assertDisposableTestDatabase`, child-first
scoped cleanup, synthetic addresses, and no fallback to the application database. Verified
afterwards that the test database holds zero users, credentials, sessions, and events. The guard
still rejects the application database by name and a non-loopback host.

## Validation

- pnpm install --frozen-lockfile: PASS; lockfile unchanged.
- pnpm db:generate: PASS; no schema or migration modification.
- pnpm format:check: PASS.
- pnpm lint: PASS; zero warnings.
- pnpm typecheck: PASS; 11 tasks.
- pnpm test: PASS; 112 unit/toolchain tests (config 22, Redis 4, database 8, worker 4, API 73 including 37 focused, plus one Node toolchain test).
- pnpm build: PASS; seven build tasks.
- pnpm check: PASS with applicable Turbo cache reuse.
- pnpm test:integration: PASS; 134 cases (API 91 including 66 focused, 35 database, 8 Redis), none skipped; three migrations, none pending.
- pnpm smoke: PASS; 19 assertions, including four new fail-fast checks for the origin allowlist.
- pnpm mobile:check and pnpm mobile:export: PASS, Android 578 modules.
- git diff --check: PASS.
- pnpm audit --audit-level=high: EXPECTED FAIL, exactly two accepted high advisories
  (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm). No new finding, no suppression.

## Defects found and fixed during review

1. `new URL` accepts a literal `*` and `,` inside a host, so `https://*.example.com` and a
   comma-joined pair were being stored as trusted origins that can never match, hiding a
   misconfiguration instead of failing startup. Host characters are now validated explicitly.
2. The exception filter detected malformed JSON by the body-parser error `type`, but Nest
   re-wraps that failure as its own `BadRequestException` and drops the type, so the parser's
   message - which quotes the submitted fragment - reached the client. Detection is now by HTTP
   status as well as type.
3. The oversized-body 413 came from the adapter parser and was not reliably distinguishable from a
   malformed body. An explicit pre-parse `Content-Length` check now yields the documented 413
   deterministically.
4. An unused import and a lint suppression were cleaned up.

## Boundaries and follow-ups

Preserved unchanged: both accepted high advisories and their unreached dispositions, the two
scoped Prisma overrides, the concurrent Prisma generation EEXIST item, the Actions Node 20-to-24
warning, the Ubuntu 24.04-to-26.04 migration notice, native device/store builds not run, non-amd64
images unverified, the Compose PostgreSQL major-version tag pin, development-only credentials, the
deferred audit-exception mechanism, InfrastructureProbe retirement, the Stage 2.2
portability/capacity/policy-evolution reviews, and the Stage 2.3 concurrency limitations.

New follow-ups, recorded in project-state.json and docs/security/AUTH_API.md:

- **No rate limiting.** The largest gap in this stage. Must not be exposed to the public internet.
- Origin allowlist is not proxy-aware; a terminating proxy must preserve the browser `Origin`.
- A session-bound double-submit CSRF token is the intended approach for later authenticated
  mutations and is deliberately not built ahead of them.
- No rehash-on-login, so Argon2id parameter evolution stays an explicit follow-up.
- Credentialed CORS absent, so the web and control apps cannot yet call the API from a browser.
- No `AuthenticationEvent` rows are written; that needs its own sanitized metadata contract.
- Revocation does not reach a request already authorized before it committed.

Not implemented: registration, password reset or recovery, email verification, refresh tokens,
logout-all, session listing, JWT, any authentication framework, rate limiting, tenant or school
enrolment, role or permission assignment, and client-side auth state.

## Git status

HEAD and origin/main both remain at 6df160a5cdd161793ce43ad0fae34235c999a84f. Nothing is staged,
committed, or pushed. No deployment occurred.

Exact next action: owner reviews the Stage 2.4 implementation, HTTP contract, and security findings.

**HARD STOP: do not commit, push, deploy, or begin Stage 2.5 without explicit owner authorization.**
