# Secure password recovery - Stage 2.5

Status: authorized contract, implemented in `apps/api/src/identity/password-recovery.*`. Global identity only.

This document is the accepted-shape reference for password recovery. It adds no account
registration, no tenant or school concept, and no authorization: recovery reaches only an existing
global `User` who already has a `PasswordCredential`.

## Surface

| Method | Path                    | Success            | Failure                                                    |
| ------ | ----------------------- | ------------------ | ---------------------------------------------------------- |
| POST   | `/auth/password/forgot` | `202` + fixed body | 400 malformed, 403 origin                                  |
| POST   | `/auth/password/reset`  | `204`, empty body  | 400 malformed/policy, 401 token, 403 origin, 413 too large |

Both routes require an exact trusted `Origin`, reuse the Stage 2.4 guard and configuration, and are
covered by the same `Cache-Control: no-store` and `Vary: Origin` middleware. The 4 KiB body limit
and the fixed malformed-request and oversized-body responses are the accepted Stage 2.4 behaviour.

No endpoint sets a session cookie. A successful reset requires the user to log in again.

### POST /auth/password/forgot

Request: `application/json` with exactly `{ "email": "user@example.com" }`.

`202` response body, identical in every eligible and ineligible case:

```json
{ "message": "If the account is eligible, password recovery instructions will be sent." }
```

The response never reveals whether the address exists, whether the `User` is `DISABLED`, whether a
credential is present, whether a token was created, whether delivery succeeded, or whether an
earlier token existed. The raw token and the reset URL are never returned to the client.

### POST /auth/password/reset

Request: `application/json` with exactly `{ "token": "...", "newPassword": "..." }`.

`204` with no body on success. No session is created and no cookie is set.

Invalid, unknown, expired, consumed, superseded, and otherwise unusable tokens all produce one
generic failure: `{ "statusCode": 401, "error": "recovery_token_invalid" }`.

A `newPassword` that violates the accepted Stage 2.2 policy produces `400`
`{ "statusCode": 400, "error": "password_policy_violation" }`. That is a safe validation error about
the submitted value only. It reveals nothing about account existence or token validity: the token is
validated _before_ the policy check, and an unusable token never reaches the policy check.

Malformed input, a wrong content type, an unexpected field, a non-string value, and an oversized body
produce the accepted Stage 2.4 `400` / `413` bodies and never echo a token or password.

## Recovery token lifecycle

| Property      | Value                                                |
| ------------- | ---------------------------------------------------- |
| Entropy       | 32 random bytes from `crypto.randomBytes` (256 bits) |
| Encoding      | canonical unpadded base64url, exactly 43 characters  |
| Persistence   | SHA-256 digest as lowercase 64-character hex         |
| Lifetime      | fixed 30 minutes, never extended                     |
| Reuse         | single use; consumption sets `usedAt` once           |
| Supersession  | issuing a new token consumes all earlier ones        |
| Normalisation | none; never trimmed or canonicalised                 |

`PasswordResetToken` already carries `userId`, unique `tokenHash`, `expiresAt`, `usedAt`, and
`createdAt`, so **no schema or migration change is required**. Consumption is a conditional update
that matches only an unused, unexpired row, so two concurrent redemptions cannot both succeed.

The digest is sufficient to look a token up, so a lost token is not recoverable; that is intended.

## Delivery abstraction

`PasswordRecoveryDelivery.sendRecoveryInstructions(...)` receives only the destination address, the
display name, the raw token, and the absolute reset URL. It is an internal interface: it has no HTTP
shape and no public email provider is introduced by this stage.

The reset URL is built from `API_PASSWORD_RECOVERY_URL_BASE`, a startup-validated absolute URL. It is
**never** derived from `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, or `Referer`, and validation
rejects credentials, wildcards, and non-absolute values. A misconfigured base fails startup rather
than producing a link that points somewhere unexpected.

### Delivery availability

No real mail provider is authorized or configured in this stage, so delivery mode is explicit
configuration rather than an implicit default:

| `API_PASSWORD_RECOVERY_DELIVERY_MODE` | Behaviour                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` (default)                  | Both endpoints fail closed with `503 service_unavailable`. No token is created, no email is attempted, and no account state changes.          |
| `development-only`                    | Permitted only when `NODE_ENV` is `development` or `test`. Rejected at startup under `NODE_ENV=production`. Uses the in-memory adapter below. |

Configuration validation enforces the production rule, so enabling the public recovery workflow
without real delivery requires a code change and an owner decision, not just an environment variable.

The development adapter records deliveries **in memory only**, exposed through the internal interface
and to tests. It does not write to stdout, a log, a file, or the database, so a token cannot leak
through an operational channel. It cannot be selected under `NODE_ENV=production` at all.

**Real delivery is not available.** Password recovery is therefore not usable in production, and the
endpoints fail closed there. This stage does not claim production readiness.

## Enumeration resistance

Issuance is externally indistinguishable across unknown address, `DISABLED` user, and missing
credential: same status, same body, same headers. An ineligible request performs no write.

The ineligible path still pays a comparable amount of work: it runs an Argon2id verification against
the Stage 2.4 decoy digest and performs a dummy reset-URL build, so it is not distinguishable from
the eligible path by a single request. As in Stage 2.4 this is **not** a constant-time claim: the
eligible path additionally writes a row and performs delivery work, repeated sampling can separate
them, and there is no throttling.

Recovery never creates an account. An unknown address is a no-op beyond the fixed response.

## Atomicity and transaction design

A reset performs all seven security-sensitive steps inside one `prisma.$transaction`, in this order:

1. **Per-user advisory lock.** `pg_advisory_xact_lock` on a stable 64-bit hash of the user ID. This
   serialises concurrent resets for one user without a schema change and without blocking other users.
   It is released automatically at commit or rollback.
2. **Conditional token consumption.** `UPDATE password_reset_tokens SET used_at = now WHERE token_hash
= $digest AND used_at IS NULL AND expires_at > now`. A count of 1 means this caller won the
   redemption; 0 means unknown, expired, consumed, or superseded, all of which are one generic failure.
3. **Credential replacement** through the accepted Argon2id hasher, with `passwordChangedAt` advanced
   strictly past its previous value.
4. **Supersession** of any other outstanding token for that user.
5. **Session revocation** of every unrevoked, unexpired session for that user.

Steps 2 to 5 either all commit or all roll back. A failure at any step leaves the credential, the
token, and the sessions exactly as they were; a caller cannot end up with a consumed token and an
unchanged password, or a new password with live sessions.

Argon2id hashing happens **before** the transaction opens, so the transaction never holds a database
connection across a 64 MiB allocation. The cost is that the digest is computed from a token that may
lose the redemption race; that is harmless because nothing has been written yet.

### Concurrency model

| Race                              | Outcome                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two redemptions of one token      | The advisory lock plus the conditional update allow exactly one success; the other gets the generic failure.                                                                                                      |
| Two different resets for one user | Serialised by the advisory lock. Both may succeed if both tokens were valid; the second wins the password.                                                                                                        |
| Reset versus issuance             | Serialised when the issuance path takes the same lock; otherwise the reset may consume a token that issuance superseded, and the reset gets the generic failure. Both outcomes are safe.                          |
| Reset versus account disabling    | The lock is taken by the reset only. A disable that lands after the revocation leaves an active credential on a disabled user; validation rejects the user, so no session can be used. Documented, not prevented. |
| Reset versus logout or revoke-all | Both are conditional writes on `revokedAt`; the result is the union, which is correct.                                                                                                                            |
| Reset versus session creation     | Closed by the shared per-user advisory lock and the in-lock credential revalidation. See below.                                                                                                                   |

## Session revocation and the login synchronization protocol

### The race this stage had to close

`SessionService.createSession` inserted a session with no coordination, while reset replaced the
credential and revoked sessions inside a transaction. A login therefore had this timeline:

```
login                      reset
----                      -----
verify password  (old)  ->  authentication succeeds against credential V1
                          lock, consume token, replace credential -> V2
                          revoke sessions where revokedAt IS NULL   (none exist yet)
                          COMMIT
insert session                  <- session now authorised by password V1, which no longer exists
```

The inserted session survived the reset and remained usable. The user who reset a compromised
password did not evict the attacker.

### The protocol

Both participants now take the same **transaction-scoped PostgreSQL advisory lock**, keyed by
`hashtextextended(user_id, 0)`, on the **same transaction client** that performs their writes:

```
password reset:  lock -> consume token -> replace credential -> supersede -> revoke sessions -> COMMIT
login:           verify password (no lock) -> lock -> revalidate credential version -> insert session -> COMMIT
```

The lock key derives from database state, so every API instance, container, and connection agrees on
it without any in-process coordination. A process-local mutex would not: it would be invisible to a
second replica. The lock is released automatically on commit or rollback, so no error path can leak
it.

Argon2id deliberately stays **outside** the lock. A 64 MiB, three-iteration allocation must not run
while holding a lock, and it must not serialise logins for one user. The consequence is that the
credential can change between verification and insertion, which is exactly what the in-lock
revalidation detects: the login re-reads `passwordChangedAt` and refuses if it differs from the value
observed at verification. Every credential replacement advances that timestamp strictly
(`Math.max(Date.now(), previous + 1)`), so a change is unambiguous. The digest itself is never handed
to the caller, so the check cannot become a credential-comparison oracle.

### What this guarantees

The invariant is: **a login authenticated with a password that a completed reset replaced must not
create a usable session after that reset.** Three orderings are exhaustive, and all are safe:

| Ordering                  | Outcome                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The login commits first   | The reset takes the lock afterwards and revokes the session it just created.                                                         |
| The reset commits first   | The login takes the lock afterwards, sees the advanced version, and refuses with the same generic failure a wrong password produces. |
| Either is mid-transaction | The lock makes them strictly ordered, so one of the two cases above applies.                                                         |

Also covered: concurrent valid logins are serialised but all admitted; concurrent resets yield
exactly one winner; a disabled account is rejected in-lock; an aborted transaction rolls back the
whole reset and releases the lock.

### What this does not do

- It does **not** cancel an HTTP request that was already authorized. A request that completed
  validation before the reset and is still executing finishes normally; revocation only affects
  subsequent validation.
- It does **not** shorten the lock held by a login in progress; it removes the _gap_ between
  verification and insertion, which is where the vulnerability was.
- It does **not** order recovery issuance against login. Issuance touches only reset tokens and
  never the credential, so no ordering is required.
- It adds no schema column and no migration.

### Evidence

`apps/api/tests/password-recovery-race.integration.test.mjs` drives the real services against real
PostgreSQL, parking a login at the exact seam between verification and insertion with an explicit
latch - never a sleep. The critical test asserts that the stale login rejects **and** that zero
session rows exist. Disabling the lock and the revalidation makes that test fail with the login
resolving successfully, so the test genuinely detects the vulnerability rather than passing vacuously.

## Abuse risks and the deployment blocker

Stage 2.6 owns rate limiting. Stage 2.5 adds these unmitigated risks and must not be deployed:

- **Recovery email flooding** against one known address, since issuance is unbounded.
- **Token brute force**, bounded only by 256-bit entropy and the 30-minute lifetime.
- **Argon2id resource exhaustion**, since both endpoints can trigger a 64 MiB operation and neither
  is throttled. This is the most direct availability risk in the stage.
- **Token-request abuse** used to invalidate a victim's existing recovery token, since each issuance
  supersedes earlier ones.
- **No delivery provider**, so in production the workflow fails closed rather than sending anything.

There is **no approved rate limiter to reuse**. Until Stage 2.6 exists, password recovery and the
Stage 2.4 login endpoint must both stay behind a private network or an operator gate.

## Test coverage

Unit tests cover token format and entropy source, canonical encoding and digest behaviour, expiry
arithmetic, delivery-mode gating, recovery-URL validation, and the fixed public bodies.

Integration tests run against real PostgreSQL and the real HTTP application, and cover eligible,
unknown, disabled, and credential-less issuance, digest-only persistence, supersession, delivery
receipt, all four unusable-token classes, policy rejection, whitespace and Unicode preservation,
credential rotation, `passwordChangedAt` advance, session revocation, old-password rejection,
new-password success, replay refusal, concurrent single-redemption, rollback on induced failure,
isolation from other users, and the full Origin and body-validation matrix. Every fixture is scoped to
its own user ids; no assertion depends on a global row count.

## What is deliberately not implemented

No registration or signup, no email verification, no MFA, no tenant or school enrolment, no role or
permission assignment, no session issuance during recovery, no `AuthenticationEvent` rows, no
production email provider, no rate limiting, and no session-generation column.
