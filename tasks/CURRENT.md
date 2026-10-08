# Current task: Stage 2.5 - Secure Password Recovery

Owner: TeamStack Technologies LTD

Stage 0 and Stage 1: ACCEPTED. Stages 2.1, 2.2, 2.3 and 2.4: ACCEPTED / HOSTED VERIFIED / CLOSED.
Stage 2.5: IN PROGRESS / LOCALLY VALIDATED; NOT ACCEPTED, NOT COMMITTED, NOT PUSHED.
Stage 2 overall: NOT ACCEPTED. Stage 2.6 and later: NOT STARTED / UNAUTHORIZED.

## Starting state

Work started on main at `514c859b1daa955cbc1d39b4984df62f7d0242da`
(`docs: close Stage 2.4 hosted validation`), matching origin/main with a clean working tree. No prior
agent's uncommitted work existed and none was discarded.

## API contract

[docs/security/PASSWORD_RECOVERY.md](../docs/security/PASSWORD_RECOVERY.md) is the accepted-shape
reference.

| Method | Path                    | Success | Failures                                                        |
| ------ | ----------------------- | ------- | --------------------------------------------------------------- |
| POST   | `/auth/password/forgot` | 202     | 400 malformed, 403 origin, 413 too large, 503 delivery disabled |
| POST   | `/auth/password/reset`  | 204     | 400 malformed/policy, 401 token, 403 origin, 413 too large      |

`forgot` accepts exactly `{ email }` and always answers the same body: "If the account is eligible,
password recovery instructions will be sent." It never returns the token or the reset URL. `reset`
accepts exactly `{ token, newPassword }`, returns an empty `204`, sets no cookie, and creates no
session. Both reuse the Stage 2.4 origin guard, strict JSON validation, 4 KiB limit, and
`Cache-Control: no-store` with `Vary: Origin`.

## Recovery token lifecycle

32 random bytes from `crypto.randomBytes`, canonical unpadded base64url of exactly 43 characters.
Only the SHA-256 digest is persisted. Fixed 30-minute expiry, never extended. Single use: consumption
is a conditional update matching only an unused, unexpired row. Issuing supersedes every earlier
outstanding token for that user. No normalisation or trimming. The reset link places the token in the
URL fragment, not the query string.

`PasswordResetToken` already carried `userId`, unique `tokenHash`, `expiresAt`, `usedAt`, and
`createdAt`, so **no schema or migration change was required or made**.

## Delivery design and production limitations

`PasswordRecoveryDelivery.sendRecoveryInstructions(...)` is an internal port taking only recipient,
display name, raw token, reset URL, and expiry. There is no SMTP credential, no provider SDK, and no
public email service.

| Mode                 | Behaviour                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `disabled` (default) | Both endpoints fail closed with `503` **before any write**. No token, no email attempt.                              |
| `development-only`   | In-memory adapter. Permitted only when `NODE_ENV` is `development` or `test`; refused at startup under `production`. |

The reset URL is built from `API_PASSWORD_RECOVERY_URL_BASE`, a startup-validated absolute URL.
Credentials, wildcards, non-absolute values, query strings, and fragments are rejected. It is never
derived from `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, or `Referer`.

The development adapter records deliveries **in process memory only**. It writes nothing to stdout, a
logger, a file, or the database, because a token must never reach an operational channel. A unit test
asserts that console output stays empty during delivery.

**Real delivery is not available.** Password recovery is not usable in production, and the endpoints
fail closed there. Enabling it for production requires a code change plus owner authorization, not
just an environment variable.

## Atomicity and concurrency model

One `prisma.$transaction`, in order: per-user advisory lock (`pg_advisory_xact_lock` on a hash of the
user id) → conditional token consumption → compare-and-swap credential replacement → supersession of
other outstanding tokens → revocation of every unrevoked unexpired session. Any failure rolls back
everything, so a consumed token always implies a replaced password and revoked sessions.

Argon2id hashing runs **before** the transaction opens, so no connection is held across a 64 MiB
allocation. A token that loses the race after hashing has written nothing.

| Race                              | Outcome                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Two redemptions of one token      | Exactly one `204`; the other gets the generic `401`.                               |
| Two different resets, one user    | Serialised by the advisory lock; both may succeed, the second password wins.       |
| Reset versus issuance             | Both orders are safe; a reset may lose to a supersede and get the generic failure. |
| Reset versus disabling            | Eligibility is re-checked under the lock, so a disabled user gets no new password. |
| Reset versus logout/revoke-all    | Both are conditional writes on `revokedAt`; the union is correct.                  |
| **Reset versus session creation** | **Not fully closed. Escalated below.**                                             |

## Resolved blocker: the session-creation race

### Root cause

`SessionService.createSession` inserted a session with no coordination, while reset replaced the
credential and revoked sessions inside a transaction. A login could therefore verify the old
password, have the reset complete, and then insert a session that was authorised by a password which
no longer existed. Resetting a compromised password did not evict the attacker.

### The protocol

Both participants take the same **transaction-scoped PostgreSQL advisory lock**,
`pg_advisory_xact_lock(hashtextextended(user_id, 0))`, on the **same transaction client** that
performs their protected writes:

```
reset: lock -> consume token -> replace credential -> supersede -> revoke sessions -> COMMIT
login: verify password (no lock) -> lock -> revalidate version -> insert session -> COMMIT
```

The key derives from database state, so every instance, container, and connection agrees without
in-process coordination; a process-local mutex would be invisible to a second replica. The lock is
released automatically on commit or rollback.

Argon2id stays **outside** the lock: a 64 MiB three-iteration allocation must not run while holding a
lock, and must not serialise concurrent logins. The consequence is that the credential can change
between verification and insertion, which the in-lock revalidation detects - the login re-reads
`passwordChangedAt` and refuses if it differs from the value seen at verification. The digest is
never handed to the caller, so the check cannot become a credential-comparison oracle.

### Precise guarantees

| Ordering               | Outcome                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Login commits first    | Reset takes the lock afterwards and revokes the session the login created.                    |
| Reset commits first    | Login takes the lock afterwards, sees the advanced version, refuses with the generic failure. |
| Either mid-transaction | The lock forces one of the two orders above.                                                  |

Also: concurrent valid logins all admitted with distinct sessions; concurrent resets yield exactly one
winner with no partial application; disabled accounts rejected in-lock; aborted transactions roll back
the whole reset and release the lock.

### What is explicitly not claimed

This does **not** cancel an HTTP request that was already authorized - revocation only affects
subsequent validation. It does not order recovery issuance against login, which is unnecessary
because issuance never touches the credential. No schema column and no migration were added.

### Evidence

`apps/api/tests/password-recovery-race.integration.test.mjs`: 21 real-PostgreSQL tests that park a
login at the exact seam between verification and insertion with an explicit latch - no sleeps, no
timing assumptions. The critical test asserts the stale login rejects **and** that zero session rows
exist. **Negative control:** temporarily disabling both the lock and the revalidation makes that test
fail with the login resolving successfully, so it genuinely detects the vulnerability rather than
passing vacuously. 21 passed on three consecutive runs.

## Enumeration resistance

Unknown address, disabled account, and missing credential all produce a byte-identical `202` with the
same headers, and perform no write. Each ineligible path still runs a real Argon2id verification
against the Stage 2.4 decoy digest so it is not distinguishable by duration alone. Recovery never
creates an account. **Not a constant-time claim.**

## Password replacement

Reuses the accepted Stage 2.2 policy and Argon2id implementation unchanged. Unicode and whitespace
semantics preserved, no trimming or normalisation, lone surrogates rejected, no test-only cost
reduction, only the digest stored, `passwordChangedAt` advanced strictly past its previous value. The
digest is never returned. A policy violation yields `400 password_policy_violation`, checked _after_
token validation so it cannot disclose token validity or account existence.

## Tests

Focused unit: 23 PASS. Token entropy, format, canonical encoding, digest determinism, expiry
arithmetic, fragment-not-query URLs, delivery gating and in-memory-only recording, and eight
configuration cases including the production refusal and six rejected URL bases.

Focused integration: 53 PASS against real PostgreSQL and the real HTTP application. Eligible, unknown,
disabled, and credential-less issuance with byte-identical responses; digest-only persistence;
30-minute expiry; supersession; delivery receipt; all unusable-token classes; policy rejection
without token consumption; whitespace and Unicode preservation; credential rotation;
`passwordChangedAt` advance; session revocation; old-password rejection; new-password success; replay
refusal; cross-user isolation; concurrent single-redemption; concurrent issuance/reset ordering;
rollback on induced failure; disable/reset; the full Origin matrix including four spoofed headers;
body validation, content type, size limit, and query-token refusal; no-store; and a separate app
booted with delivery disabled proving it fails closed with no token written.

Concurrency suite: 21 PASS. See **Resolved blocker** above for the case list and the negative control.

Every fixture is scoped to its own user ids; no assertion depends on a global row count.

## Validation

- pnpm install --frozen-lockfile: PASS; lockfile unchanged.
- pnpm db:generate: PASS; no schema or migration modification.
- pnpm format:check: PASS.
- pnpm lint: PASS; zero warnings.
- pnpm typecheck: PASS; 11 tasks.
- pnpm test: PASS; 135 unit/toolchain tests (config 26, Redis 4, database 8, worker 4, API 96 including 23 focused, plus one Node toolchain test).
- pnpm build: PASS; seven build tasks.
- pnpm check: PASS with applicable Turbo cache reuse.
- pnpm test:integration: PASS; 208 cases (API 165 including 74 focused recovery, 35 database, 8 Redis), none skipped; three migrations, none pending.
- pnpm smoke: PASS; 19 assertions.
- pnpm mobile:check and pnpm mobile:export: PASS, Android 578 modules.
- git diff --check: PASS.
- pnpm audit --audit-level=high: EXPECTED FAIL, exactly two accepted high advisories (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm). No new finding, no suppression.

## Changed accepted code

Stage 2.5 modifies three previously accepted files, all within the authorized boundary:

1. `apps/api/src/identity/auth.service.ts` - login now verifies the password, then takes the advisory
   lock and revalidates the credential version in a transaction before inserting the session.
2. `apps/api/src/identity/session.service.ts` - the insert body is factored into a private method and
   exposed as `createSessionInTransaction(tx, userId)` so a caller holding the lock can write on its
   own transaction client. The accepted `createSession` behaviour is unchanged.
3. `apps/api/src/identity/password-credential.service.ts` - adds `verifyCredentialVersioned`, which
   returns the verification result plus the credential version observed. The accepted
   `verifyCredential` is unchanged.

The Stage 2.4 scope regression test was also updated: it asserted the two recovery routes return
`404`, which was correct when recovery did not exist and is superseded by this authorization.
Registration, signup, password change, session listing, logout-all, revoke-all, school join, tenant,
and refresh routes remain asserted absent.

## Boundaries and follow-ups

Preserved unchanged: both accepted high advisories and their unreached dispositions, the two scoped
Prisma overrides, the concurrent Prisma generation EEXIST item, the Actions Node 20-to-24 warning, the
Ubuntu migration notice, native device/store builds not run, non-amd64 images unverified, the Compose
PostgreSQL tag pin, development-only credentials, the deferred audit-exception mechanism,
InfrastructureProbe retirement, the Stage 2.2 portability/capacity/policy reviews, and the Stage 2.4
deployment blocker and deferred CSRF design.

Remaining architectural limitations, recorded in project-state.json:

- Concurrent logins for one user serialise on the advisory lock for the in-transaction revalidation
  and insert. That section performs no Argon2id work, so the window is short, but it is a per-user
  serialisation point.
- The lock is advisory, so it coordinates only writers that take it. Any future session-creation path
  must also participate; the single existing production path is covered and asserted by a regression
  test.

Still open: no real email provider; recovery email flooding; token brute force; Argon2id resource
exhaustion; token-request abuse invalidating a victim token; the non-proxy-aware trusted-origin
configuration.

Not implemented: registration, email verification, MFA, password change while authenticated, a real
email provider, rate limiting, `AuthenticationEvent` recording, session issuance during recovery, and a
session-generation column.

## Git status

HEAD and origin/main both remain at `514c859b1daa955cbc1d39b4984df62f7d0242da`. Nothing is staged,
committed, or pushed. No deployment occurred.

Exact next action: owner reviews the Stage 2.5 implementation, the resolved race, and the atomicity
design.

**HARD STOP: do not commit, push, deploy, or begin Stage 2.6 without explicit owner authorization.**
