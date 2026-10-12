# Stage 2.7 - Security Events and Sanitization

Owner: TeamStack Technologies LTD. Stage 2.7 is **IMPLEMENTATION COMMITTED / HOSTED VERIFICATION PENDING**.

This document is the contract for what the system records about authentication, what it deliberately does
not record, and where the boundary between a durable audit record and an operational log line is drawn.

---

## 1. What this stage is for

The system must be able to answer, after the fact:

| Question                                      | Answered by                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Was a sign-in successful or refused?          | `LOGIN_SUCCEEDED` / `LOGIN_FAILED`                                               |
| Was a session revoked?                        | `LOGOUT`, `SESSION_REVOKED`                                                      |
| Was a password reset requested and completed? | `PASSWORD_RESET_REQUESTED` / `PASSWORD_RESET_COMPLETED`                          |
| Was a request refused by abuse protection?    | Throttled `auth_rate_limited` log line                                           |
| Did an authentication dependency fail?        | Throttled `auth_enforcement_unavailable` / `argon2id_admission_refused` log line |

It must do so **without** exposing passwords, session bearer tokens, recovery tokens, password hashes,
`Authorization` or `Cookie` headers, Redis keys, database credentials, HMAC secrets, or whole request
bodies.

---

## 2. The accepted schema, reused unchanged

Stage 2.1 already modelled the table and this stage deliberately does not touch it.

```prisma
model AuthenticationEvent {
  id         String                  @id @default(uuid(7)) @db.Uuid
  userId     String?                 @db.Uuid
  eventType  AuthenticationEventType
  occurredAt DateTime                @default(now())
  requestId  String?
  @@index([userId, occurredAt])
}
```

**Four writable columns.** No metadata column, no source-address column, no free-text column.

That absence is the most important privacy property of this stage, and it is **structural rather than
procedural**: the recorder's input is a closed event type plus an optional user id and an optional
correlation id. There is no parameter through which a caller could pass a payload, so no amount of care
at a call site is required to keep one out. If a future stage needs richer events, that is a schema
decision requiring owner authorization - it is not a new field to add to the recorder.

`ON DELETE RESTRICT` on `userId` now does real work: with rows actually written, deleting a user is
blocked rather than silently destroying the record of what happened to them.

---

## 3. Event taxonomy and exact semantics

### 3.1 Written by this stage

| Event                      | Fires when                                                                                            | Guaranteed not to fire when                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `LOGIN_SUCCEEDED`          | The login transaction committed **and** the session row exists. Written inside that same transaction. | The transaction rolled back for any reason.                                                                                            |
| `LOGIN_FAILED`             | A credential verification was refused: unknown address, wrong password, or a disabled account.        | The body was malformed (`INVALID_REQUEST` - a rejected request, not an authentication attempt), or Argon2id admission or Redis failed. |
| `LOGOUT`                   | A presented session was still live and was revoked, in one transaction with the revocation.           | No valid session was presented, or the session was already revoked.                                                                    |
| `SESSION_REVOKED`          | A password reset revoked a live session. One row per session the reset's own UPDATE revoked.          | Any session that was not revoked by that reset.                                                                                        |
| `PASSWORD_RESET_REQUESTED` | The recovery token row committed, in the same transaction.                                            | The account was ineligible, so no token existed.                                                                                       |
| `PASSWORD_RESET_COMPLETED` | The reset transaction committed: token consumed, credential replaced, sessions revoked.               | The transaction aborted, so the credential was not replaced.                                                                           |

`LOGIN_SUCCEEDED` means **the session is persisted**. `PASSWORD_RESET_COMPLETED` means **the transaction
committed**. Neither is inferred from a handler merely starting.

### 3.2 Deliberately unused

| Reserved           | Why                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_DISABLED` | Describes a state change. No account-disable action exists. Emitting it when a login is merely _refused_ on a disabled account would assert a disablement that did not happen, so those refusals are `LOGIN_FAILED`. |
| `PASSWORD_CHANGED` | A reset does change the password, but `PASSWORD_RESET_COMPLETED` already says so more precisely. Writing both would be two rows for one fact.                                                                        |
| `EMAIL_VERIFIED`   | No registration path exists.                                                                                                                                                                                         |

### 3.3 Not representable - recorded in the log instead

Three required questions have **no** suitable enum value, and inventing a near-miss type would corrupt the
audit trail:

- request denied by abuse protection,
- Redis enforcement unavailable,
- Argon2id admission unavailable.

These are emitted as structured log lines (section 6). **If the owner wants them queryable alongside events,
that is an enum migration and requires authorization.** See section 12.

---

## 4. Transaction boundaries

| Event                                         | Coupling                                                                        | Failure policy                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `LOGIN_SUCCEEDED`                             | **Transactional** - written on the login transaction, after the session insert. | **Fail-closed.** A refused audit write rolls the session back. |
| `LOGOUT`                                      | **Transactional** - one transaction covers revocation and the event.            | **Fail-closed.**                                               |
| `PASSWORD_RESET_REQUESTED`                    | **Transactional** - third statement in the issuing batch.                       | **Fail-closed.**                                               |
| `PASSWORD_RESET_COMPLETED`, `SESSION_REVOKED` | **Transactional** - written on the reset transaction.                           | **Fail-closed.**                                               |
| `LOGIN_FAILED`                                | **Detached, best-effort.**                                                      | Never changes the response.                                    |

### Why success events are fail-closed

The property that matters is asymmetric: _a committed success event always corresponds to a committed
operation, and a committed operation always has its success event._ Coupling the write to the same
transaction is the only way to get both directions.

The cost is real and is accepted deliberately: if `authentication_events` cannot be written, logins and
resets fail. A login that succeeds with no audit record is the exact failure an audit trail exists to
prevent, and best-effort success logging loses records precisely during the incidents where they matter.

This is proven rather than asserted. `apps/api/tests/security-events.integration.test.mjs` builds an
`AuthService` whose transaction refuses audit writes and asserts that **no session exists afterwards**.
A **negative control** confirmed the test detects the flaw: moving the write to a detached one makes the
login resolve successfully with no audit record, and the test fails.

An earlier version of that test rolled the transaction back _before_ the event write. It passed under the
negative control too, which meant it was proving nothing; it was replaced.

### Why failure events are best-effort

By the time `LOGIN_FAILED` is written the request has already failed. Coupling it to a transaction could
only convert a `401` into a `503`, which would hand an attacker a signal separating "wrong password" from
"audit write failed" - a new oracle on the accepted enumeration boundary. So the write is best-effort, and
a failure is reported through the security log rather than swallowed or surfaced.

---

## 5. Metadata allowlist

**Stored:** event type, server timestamp, user id when legitimately known, correlation id.

**Never stored, and structurally unable to be stored:** passwords, recovery tokens, session bearer tokens,
cookie values, `Authorization` headers, request bodies, password hashes or fingerprints, normalized or
presentation email addresses, client IP addresses, Redis keys, HMAC inputs, driver errors, exception
messages, stack traces.

`userId` is `null` when the identity is genuinely unknown - an unknown address, or a recovery token that
matched no row. That distinction is what makes a credential-stuffing run against one account visible, and
it is **internal only**: no endpoint reads this table, so it creates no enumeration oracle.

Email addresses are never stored. The table has no column for them, so recording one would need a schema
change, which would need owner authorization.

---

## 6. Operational security log, and why it exists

Rate-limit denials, Redis unavailability, Argon2id refusals, rejected recovery tokens, audit-write failures,
and unexpected request errors are recorded as structured JSON lines on **stderr**.

### Why not as event rows

All of them are attacker-triggerable without limit, and three are produced _by the traffic that is already
being refused_. Writing a row per denial would turn the abuse limiter into a database-amplification attack,
with the write happening exactly when the system is asking the caller to stop.

The asymmetry is worth stating plainly: **stored events are already bounded and need no throttle.**

- `LOGIN_FAILED` cannot exceed the Stage 2.6 per-account credential meter.
- `LOGOUT`, `SESSION_REVOKED`, `PASSWORD_RESET_*` all require a real session or a real token.
- Denials never reach a handler, so they never produce rows.

### Bounded emission

Per `(kind, endpoint)`, the first record in a five-second window is written, further records are counted,
and exactly one aggregate is emitted when the window rolls. The worst case is **two lines per key per
window** regardless of how hard the endpoint is hammered, so a sustained flood stays visible as a count
rather than becoming a write amplifier. The throttle map is additionally capped at 256 keys.

### Field allowlist

`kind`, `requestId`, `endpoint`, `userId`, `reason`, `count`, `suppressed`. All are closed enumerations or
UUID/bounded-integer values. Sanitisation builds the output **from scratch** rather than mutating the input,
so a caller that invents a field has it dropped. This is a structural filter over a closed set, not a
regular expression trying to recognise secrets in a string.

**No client IP address is logged.** It is personal data, it is unnecessary given the correlation id, and
recording it would conflict with minimising student data.

---

## 7. Correlation

The API had no request id, so Stage 2.7 adds one: a random UUID generated per request, stored on a
**symbol-keyed** request property so nothing can overwrite it, and echoed in `X-Request-Id` so a user can
quote it in a support request.

**Any inbound `X-Request-Id` is ignored.** Trusting a client value would let an attacker correlate
unrelated requests by reusing one, and would place chosen text into an audit row.

The id is generated in the request middleware and normalised to a UUID again before storage; anything
malformed is dropped rather than stored, and dropping degrades correlation rather than failing a request.

---

## 8. Error sanitization

`SafeHttpExceptionFilter` keeps its accepted behaviour for malformed JSON and oversized bodies, and now
handles the remaining unknown-error case explicitly instead of delegating it:

- The framework's `handleUnknownError` echoes `exception.message` for any thrown value shaped like an HTTP
  error - an object with a string `message` and a numeric `statusCode` in `[400, 600)`. That is a latent
  disclosure path. This stage replaces it with a constant body.
- The framework also logs the raw exception object, which is a silent no-op because Nest's logger is
  disabled - so an unexpected failure produced **no record at all**. It is now recorded sanitised.

`HttpException` still delegates to the framework filter, because every one in this codebase is built with a
hand-written fixed body. **No accepted public response contract changes**, including the Stage 2.6 `429` and
`503` bodies.

Logging discipline elsewhere is unchanged and already sound: configuration errors name keys only, and no
code logs a raw request, exception object, or URL.

---

## 9. Volume controls

The takeover review checked the earlier claim that stored events are "inherently bounded" by Stage 2.6.
**It is only partly true**, and the table states what actually bounds each writer.

| Event                      | Durable rows written                   | What bounds it                                                                                                                                                                        |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOGIN_FAILED`             | One per **admitted** failed attempt    | Per-account 8 / 15 min, per-source 10 / 5 min, **and** the global Argon2id budget of 120 / min. A refused request never reaches the handler and writes nothing.                       |
| `LOGIN_SUCCEEDED`          | One per session created                | **Only** the global Argon2id budget (120 / min fleet-wide, about 172,800 / day). Successful logins are refunded by the Stage 2.6 design, so no per-account or per-source cap applies. |
| `LOGOUT`                   | One per live session actually revoked  | The number of live sessions; 30 / min per source.                                                                                                                                     |
| `PASSWORD_RESET_REQUESTED` | One per issued token                   | Per-target 3 / h, per-source 5 / 15 min, global budget.                                                                                                                               |
| `PASSWORD_RESET_COMPLETED` | One per valid single-use token         | A valid token.                                                                                                                                                                        |
| `SESSION_REVOKED`          | One per live session the reset revoked | **The user's live session count, which has no per-user cap.** See below.                                                                                                              |
| Denials, outages, refusals | **None** - throttled log lines only    | 2 lines per `(kind, endpoint)` per 5 s per process.                                                                                                                                   |
| Malformed requests         | None                                   | Not an authentication attempt.                                                                                                                                                        |

### What the analysis found

- **Every login-path row is bounded by the global budget.** A login that writes an event has spent one unit
  of the 120 / min Argon2id budget, which is never refunded. So login events cannot exceed 120 / min across
  the deployment however a caller varies address, account, or source.
- **`LOGIN_SUCCEEDED` has no per-account bound.** An attacker holding one valid credential can create
  sessions and events at up to the global rate. This is the same rate at which the pre-existing `sessions`
  table already grows, so Stage 2.7 adds one row per row rather than a new multiplier. It is nevertheless a
  gap, and it is pinned by a test so a change to it is a visible decision.
- **`SESSION_REVOKED` fans out, and writing it per row had a measured failure point, since corrected.** One
  reset writes one row per live session. The original per-row write failed closed at about 20,000 live
  sessions. It is now one set-based statement (section 16) that succeeds through at least 100,000 on the
  reference machine and fails at 150,000, close to the accepted revoke-only boundary. No per-user session cap
  exists, so the theoretical ceiling (the global login rate times the session lifetime) is still above both.
- **Logout cannot be used to mint rows.** Only the request that actually flips `revokedAt` writes an event;
  an already-revoked or unknown session writes none. Forty concurrent logouts of one session produce one row.
- **Redis outages and denials write no rows**, so they cannot amplify into the database.
- **Log volume is per process.** The throttle bounds each process to two lines per key per window, so _N_
  replicas emit up to _N_ times that. This is a disk bound, not a correctness property.

A rate-limit flood is asserted to produce no stored rows, by correlation id rather than by count alone.

---

## 10. Failure modes

| Condition                               | Behaviour                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Audit write fails on login/reset/logout | Operation fails; nothing partial commits. `security_event_write_failed` is logged.                          |
| Audit write fails on a refused login    | Response unchanged (`401`); failure logged. Never becomes a `503`.                                          |
| Redis unavailable                       | `auth_rate_limited` / `auth_enforcement_unavailable` logged; endpoints fail closed exactly as in Stage 2.6. |
| Argon2id admission refused              | `argon2id_admission_refused` logged; `503`, no hashing attempted.                                           |
| Database unavailable                    | Operation fails as before; a failure event cannot be written, and that is logged where possible.            |
| Log sink throws                         | Swallowed. Diagnostics must never break a request.                                                          |
| Process shuts down mid-request          | No special handling; in-flight transactions roll back and leave no success event.                           |
| Concurrent duplicate resets             | Exactly one completes; the rest are generic `401`s with no completion event.                                |

**Exactly-once is not claimed.** Concurrent duplicate requests each produce their own truthful outcome;
no deduplication is attempted, and none is needed for correctness.

---

## 11. Test evidence

`apps/api/tests/security-events.test.mjs` (25 unit), `apps/api/tests/startup-and-di.test.mjs` (15 unit), and
`apps/api/tests/security-events.integration.test.mjs` (42 integration), against real PostgreSQL and Redis and
driven through the real HTTP application where the behaviour is HTTP-visible:

1. a successful login records exactly one correlated `LOGIN_SUCCEEDED`;
2. a failed login records `LOGIN_FAILED` with correct attribution; an unknown account records `null`, matched
   by this request's own correlation id rather than by whatever the table holds;
3. known and unknown accounts return **byte-identical** responses;
4. reset completion is recorded only after commit, and a refused reset writes none;
5. **a failing audit write rolls back the login, the reset, and the logout**, each proven by making the audit
   write itself fail rather than by rolling back earlier;
6. **a refused login stays a `401` when its failure row cannot be written**;
7. **a credential changed between verification and the session transaction** yields one `LOGIN_FAILED` and no
   success;
8. **a session logout revoked while the reset was in flight is not also reported as revoked by the reset**;
9. expired, consumed, and superseded recovery tokens change nothing and write no completion;
10. a disabled account is `LOGIN_FAILED`, never an account-disabled event;
11. logout is idempotent and records nothing when nothing was revoked;
12. refused requests leave no row, for login, recovery, and logout floods;
13. successful-login volume is pinned as an acknowledged gap;
14. no password, recovery token, session token, or address appears in any column;
15. deleting a user is blocked by `ON DELETE RESTRICT`;
16. every injected class resolves a real type (the Stage 2.7 startup failure), startup errors never print a
    connection secret, and the unknown-error filter path never echoes an exception message;
17. the stale-build guard refuses a stale, missing, or orphaned compiled file.

### Negative controls

Each was run, observed to fail, then reverted and re-verified.

| Control                                                 | Result                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Move `LOGIN_SUCCEEDED` out of its transaction           | The coupling test fails; the login succeeded with no audit record.     |
| Count `SESSION_REVOKED` by a read before the update     | The interleaving test fails, reporting 3 revocations where 2 happened. |
| Make the log allowlist a pass-through                   | Three sanitisation tests fail.                                         |
| Make the guard's `SecurityLog` import type-only         | Two DI tests fail; a real boot rejects with a legible message.         |
| Edit `src` without rebuilding, then run vitest directly | Both configs refuse to start and say how to rebuild.                   |

An earlier version of the coupling test rolled the transaction back _before_ the event write and passed under
the first control, which showed it proved nothing. It was replaced.

---

## 12. Known limitations and remaining risks

1. **Three required questions are not queryable in the event table.** Rate-limit denials, Redis
   unavailability, and Argon2id refusals exist only as log lines. If they must be queryable alongside
   events, the enum needs extending - a migration requiring owner authorization.
2. **`PASSWORD_RESET_REQUESTED` is written directly** in the issuing transaction rather than through the
   recorder, because that transaction is the batch form. It is built with the recorder's own row function
   (`securityEventRow`), so it passes the same vocabulary and UUID checks. (An earlier revision claimed this
   and did not do it; the review corrected the code to match.)
3. **Throttle state is per process.** Two replicas behind one load balancer emit up to two lines per key
   per window each. This is a disk bound, not a correctness property.
4. **Log lines are not durable.** They are lost on crash and on log rotation. Events are durable.
5. **No event read API exists**, so the table is currently write-only. Adding one requires authorization
   and an access-control design.
6. **Retention is undefined.** No purge, archive, or retention policy exists; `occurredAt` is the only
   temporal handle. Automation belongs to a later stage but needs a decision.
7. **`LOGIN_FAILED` reveals account existence to anyone who can read the table.** That is the point of the
   column, but it makes table access a privileged operation. Access control is not yet defined.
8. **Stage 2.6 limitations persist**: lease-expiry over-admission, Redis as a hard dependency, lost
   refunds, no approved proxy model, shared TLS-proxy production blocker, HMAC secret rotation, provisional
   thresholds, untested Redis Cluster.
9. **No alerting.** Events and log lines are recorded; nothing watches them. Stage 2.7 is recording, not
   detection.
10. **`SESSION_REVOKED` fan-out has no per-user session cap.** A reset is one transaction, so it still fails
    closed beyond roughly 100,000 live sessions on the reference machine (section 16). That is close to the
    accepted pre-Stage-2.7 boundary and above any plausible legitimate count, but it is not removed.
11. **`LOGIN_SUCCEEDED` is bounded only by the global Argon2id budget** (section 9).
12. **The `LOGIN_FAILED` write runs while the Argon2id slot is held**, so a slow database lengthens slot
    occupancy. The slot lease renews, so this degrades throughput rather than correctness.
13. **Not production readiness.** Production deployment remains prohibited.

---

## 13. Privacy and retention requirements for a later stage

- Events contain no student data beyond a user id and a timestamp; the user id is pseudonymous.
- Access to `authentication_events` must be restricted to authorised personnel with an audit of that access.
- A retention period must be set, with events purged or archived after it.
- Deleting a user is currently blocked by `RESTRICT`; a lawful-erasure path that preserves non-identifying
  security history while removing the identifier needs design.
- Log sinks must not be shipped to third-party analytics without the same review.

---

## 14. Takeover review and the uncovered categories

### Review findings and corrections

| Finding                                                                                                                              | Disposition                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SESSION_REVOKED` was counted by a read taken before the update, and logout takes no lock, so a concurrent logout was reported twice | **Fixed.** The count now comes from the rows the update itself revoked. Proven by a control.   |
| The exception filter held a second `SecurityLog`, so the documented per-process bound was not shared                                 | **Fixed.** The filter now resolves the one provider.                                           |
| `abortOnError` defaulted to `true`, so any dependency-injection failure aborted silently                                             | **Fixed.** Startup rejects with a message that is allowlisted for Nest resolution errors only. |
| A disabled-during-login refusal returned `401` with no `LOGIN_FAILED` row                                                            | **Fixed.**                                                                                     |
| A token rejected inside the reset transaction was not logged                                                                         | **Fixed.**                                                                                     |
| `PASSWORD_RESET_REQUESTED` bypassed sanitisation while the document said it did not                                                  | **Fixed** in code; the document is corrected.                                                  |
| Integration tests import `dist` and a direct package run does not rebuild                                                            | **Guarded.** A global setup refuses stale, missing, or orphaned output in both configs.        |
| Two orphaned `dist` files from renamed or deleted sources existed                                                                    | Removed (generated, git-ignored output with no source).                                        |
| `rate-limit-concurrency.integration.test.mjs` never removed its users, and null-user events matched no per-suite cleanup             | **Fixed.** A full run now leaves zero net rows, measured before and after.                     |
| Several tests were vacuous (`<= 20` of 20; any orphan row satisfied the unknown-account test)                                        | **Replaced** with assertions tied to this request's own rows.                                  |
| The coupling test built `AuthService` without its `securityLog` argument                                                             | **Fixed** by a shared builder that wires it as the module does.                                |

### Leftover test rows

The test database `tsms_test` held 581 synthetic users (all `@example.test`), from runs on 2026-10-09 to
2026-10-11. The database is the dedicated `TEST_DATABASE_URL` target, loopback, with the `_test` suffix the
repository guard requires; the application database `tsms` holds no tables. Causes: interrupted runs, the
never-cleaning suite above, and null-user events no suite could attribute. `pnpm db:test:migrate` runs
`migrate deploy` and does not reset data, so rows persist between runs. **They were not removed**: a targeted
delete was declined by the execution environment, and the owner has not approved one. The suites do not
depend on them and a full run leaves the count unchanged.

### Log-only versus durable events for rate-limit, outage, Argon2id, and rejected-token outcomes

| Option                                  | For                                                                                | Against                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Throttled log lines only (implemented)  | No amplification; no schema change; works while Redis and the database are failing | Not durable; throttle is per process; not queryable beside events; depends on a log sink that does not yet exist                         |
| New enum values and one row per outcome | Queryable with the rest of the audit trail                                         | Migration; the write happens exactly when the system tells a caller to stop, so it is a database-amplification vector; fails with the DB |
| New enum values and sampled rows        | Queryable and bounded                                                              | Migration; sampling loses counts; needs a coordination point or accepts per-process sampling                                             |

**Recommendation:** accept log-only for Stage 2.7, on the condition that the owner treats log retention and
alerting as a prerequisite for any production use, and defer the enum extension to the stage that designs
retention, access control, and alerting together. Those three decide whether queryable denial events are
worth their write path. This is a recommendation; the decision is the owner's.

---

## 15. Final design review (owner decisions applied)

### Owner decisions recorded

| Decision                                                                                     | Status         |
| -------------------------------------------------------------------------------------------- | -------------- |
| Keep rate-limit, Redis, Argon2id, and rejected-token outcomes as sanitised log-only outcomes | **Approved**   |
| Database migration or enum expansion                                                         | Not approved   |
| Per-user session cap                                                                         | Not approved   |
| Aggregate row replacing individual `SESSION_REVOKED` rows, without proof of truthful meaning | Not approved   |
| Deleting existing test-database rows                                                         | Not approved   |
| Removing the unexplained `apps/api/probe.txt`                                                | Not approved   |
| Commit, push, deployment, Stage 2.8                                                          | Not authorised |

### 15.1 `SESSION_REVOKED` semantics, volume, and the measured ceiling

**Semantics.** One `SESSION_REVOKED` row means **one individual session that this password reset revoked**:
the count is taken from the rows the reset's own `UPDATE` changed, in the same transaction, so a session that
a concurrent logout revoked first is reported by `LOGOUT` only. It is emitted only by a committed reset. It is
never one row per operation, and it does not identify which session (the table has no column for that).

**Is a bounded truthful representation possible with the accepted schema? No.** The table has four writable
columns and no count, no session id, and no free text. A single row per reset would assert "a reset revoked
sessions" and lose the number, which is a different statement from the one the type name makes and would be a
silent change of semantics. A capped number of rows would claim fewer revocations than occurred. The
implementation therefore keeps one truthful row per revoked session and does not add a cap or change the
schema.

**Measured behaviour of the original per-row write** (superseded by section 16; local PostgreSQL 17, one user with _N_ live sessions, one reset, one trial each; synthetic data, removed afterwards):

| Live sessions | Result                                  | Reset time | `SESSION_REVOKED` rows |
| ------------- | --------------------------------------- | ---------- | ---------------------- |
| 1,000         | Succeeds                                | 0.7 s      | 1,000                  |
| 5,000         | Succeeds                                | 2.2 s      | 5,000                  |
| 10,000        | Succeeds                                | 3.2 s      | 10,000                 |
| 20,000        | **Fails closed**: `503`, Prisma `P2028` | 5.9 s      | 0 (rolled back)        |
| 50,000        | **Fails closed**: `503`, Prisma `P2028` | 15.9 s     | 0 (rolled back)        |

The failure is Prisma's default 5 s interactive-transaction timeout. It is safe in the sense that matters
for an audit trail: nothing commits, so the credential is unchanged, the token is not consumed, every
session stays live, and no event exists. **It is not safe for availability.** Before Stage 2.7 the same reset
revoked any number of sessions in one statement and could not hit this limit, so Stage 2.7 introduced it.

**Who can trigger it.** Creating _N_ sessions needs _N_ successful logins with a valid credential. Successful
logins are refunded by the Stage 2.6 design, so the only bound is the global Argon2id budget of 120 / min
fleet-wide. 20,000 sessions is roughly three hours of that entire budget, which would also crowd out every
other user's logins and is therefore noticeable, but it is not prevented. A holder of a compromised
credential could use it to make the owner's password recovery fail while their sessions stay live.

**Theoretical ceiling:** 120 per minute over a 7-day session lifetime is about 1.2 million sessions for one
account.

**Resolution.** The owner then authorised a narrow correction that keeps the semantics and the schema and
replaces the per-row write with one set-based statement. See section 16 for the design, the benchmarks, and
the boundary that remains. A per-user session cap, an aggregate row, and a schema change remain **not
approved**.

### 15.2 Detached `LOGIN_FAILED` write

| Property                               | Evidence                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot reject                          | `detached` now contains row construction, the insert, and logging in one `try`. Review found row construction outside it, so an invalid type could reject; fixed. Unit tests cover a database error, an invalid type, and an un-awaited call under an `unhandledRejection` listener. The last two fail on the old code (control run). |
| Cannot leak secrets                    | The driver error is never logged or rethrown. A test makes the driver error carry a connection URL with a password and asserts the log has none of it and only allowlisted keys.                                                                                                                                                      |
| Public `401` unchanged                 | Integration test: a refused login stays `AUTHENTICATION_FAILED` when the write throws. Byte-identical known and unknown responses are asserted over HTTP.                                                                                                                                                                             |
| Known versus unknown indistinguishable | Both paths perform exactly one insert before responding, after the same Argon2id verification. No timing assertion is made, because a wall-clock comparison would be flaky; the argument is structural.                                                                                                                               |
| Latency                                | The write is awaited, so a slow database lengthens a refusal equally for known and unknown accounts. The one asymmetric path, a credential changed mid-login, exists only for a known account and is already distinguishable by being a race.                                                                                         |
| Uncontrolled database work             | One insert per admitted failure, no retry (asserted for 10 concurrent calls). Admitted failures are bounded by the Stage 2.6 meters and the global budget. Refused requests write nothing (asserted by correlation id). A flood of failed writes logs at most two lines (asserted for 500).                                           |
| Residual                               | The write runs while the Argon2id lease is held, so a slow database lengthens lease occupancy. Leases renew, so this lowers throughput rather than correctness.                                                                                                                                                                       |

### 15.3 Stale-build guard portability

`tests/support/dist-freshness.mjs` uses `node:path` throughout (`join`, `relative`, `resolve`), reads its
location from `import.meta.dirname` (Node 24 is required by `engines`), and reports paths with forward slashes
on every platform. It detects stale, missing, and orphaned compiled files, ignores `.d.ts` sources, and treats
a compiled file exactly as new as its source as current.

| Concern                   | Finding                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows                   | Exercised here. Path separators are normalised in messages, with a test for nested paths.                                                                                                         |
| Linux CI                  | Not run here, so not claimed. The code uses no Windows-specific API; ext4 keeps nanosecond mtimes, so comparison at `mtimeMs` is stricter, not looser.                                            |
| Timestamp precision       | Full `mtimeMs` resolution. A coarse filesystem could report a false stale. That fails safe and is cured by a rebuild. Not weakened with a tolerance, since a tolerance would hide real staleness. |
| Turbo cache restore       | Observed to stamp restored outputs with the restore time, so a cache hit passes. A restore that kept old mtimes would also fail safe.                                                             |
| Reproducible clean builds | `build` is `tsc` without cleaning, which is how orphans accumulated. The guard now reports them with an instruction to remove the stale output. The build script was not changed.                 |

### 15.4 Logging guarantees

- **One shared instance.** `new SecurityLog()` appears once in `src` (the module provider). The abuse guard,
  both services, the recorder, and the global exception filter all resolve it, so one throttle state covers
  them.
- **Allowlist.** Output is built from scratch from `kind`, `requestId`, `endpoint`, `userId`, `reason`,
  `count`, `suppressed`; every value is a closed enumeration, a UUID, or a bounded integer. Tests assert that
  unknown fields, out-of-set reasons, and driver or exception messages never appear.
- **Throttling is per process.** Two lines per `(kind, endpoint)` per five seconds, per process. With _N_
  replicas the bound is _N_ times that. State is lost on restart.
- **Log lines are not audit events.** They are operational diagnostics: not durable, not queryable beside the
  event table, not tamper-evident, and not complete (throttled and suppressed counts are aggregates).
  Nothing in this stage describes them otherwise.
- **Startup errors.** A Nest dependency-resolution failure is printed in full, which names classes and modules
  only. Every other startup error is reduced to its class name, so a connection error carrying a URL or password
  cannot reach the terminal. The cost is that a non-dependency startup failure is less descriptive; the class
  name still identifies it. Configuration errors already name only the offending keys.

### 15.5 Production prerequisites for log-only outcomes

Approved as log-only for Stage 2.7. Because those logs are non-durable, **production use requires**, and this
stage does not provide:

1. **Retention.** A defined period for security log lines, enforced by the log platform.
2. **Centralised collection.** Lines are written to stderr as JSON; something must ship them off the host
   before a restart or rotation loses them, and must combine replicas.
3. **Restricted access.** The lines contain user ids and correlation ids; access must be limited to authorised
   personnel and audited, and the sink must not forward to third-party analytics without review.
4. **Alerting.** Nothing watches `auth_rate_limited`, `auth_enforcement_unavailable`,
   `argon2id_admission_refused`, `recovery_token_rejected`, `security_event_write_failed`, or
   `unhandled_request_error`. Alerts on sustained rates, on `security_event_write_failed` (a failed audit
   write means logins or resets are failing closed), and on `unhandled_request_error` are needed.
5. **Aggregation awareness.** Counts in `security_log_suppressed` lines are the only record of throttled
   volume; dashboards must read them.

### 15.6 Test-database handling

The 581 historical synthetic users were neither modified nor deleted. New and changed tests remove only rows
they own: by the ids of users they created, by the correlation ids of requests they made, and (for events with
no owner) by `userId IS NULL` within a database the repository guard has already verified as a loopback `_test`
database and which no other suite uses concurrently. During this review one integration run failed under load
(a 30 s test timeout in `rate-limit-hardening`, after a 50,000-row measurement had churned the table); the
in-flight requests then wrote events after teardown, the teardown hit `ON DELETE RESTRICT`, and **one user with
six events was left behind**. A scoped delete of exactly that user was declined by the execution environment, so
it remains. `tsms_test` therefore holds 582 users and 578 events (the 581 and 572 historical rows plus that
residue). The suite passed on rerun and does not depend on any of these rows. The lifecycle defect behind the
residue is fixed in section 16.5; the residue itself was not deleted and still is not.

---

## 16. Set-based `SESSION_REVOKED` correction

### 16.1 Root cause

The per-row implementation read the live sessions, revoked them with `updateMany`, then wrote one event row
per session from the application with `createMany`. All of that ran inside Prisma's interactive transaction,
whose default timeout is 5 s. The event write grew with the session count, so above about 20,000 live
sessions the transaction timed out (`P2028`), rolled back, and the reset returned `503`. Credential, token and
sessions were unchanged, which is the correct failure for an audit trail, but the accepted Stage 2.5 reset
had no such ceiling. The audit write had become a limit on account recovery.

### 16.2 Design

`SecurityEventRecorder.revokeLiveSessionsRecordingEvents` replaces the read, the `updateMany`, and the
per-row write with one statement on the reset's transaction:

```sql
WITH moment AS (SELECT (to_timestamp($1::double precision / 1000.0) AT TIME ZONE 'UTC') AS at),
revoked AS (
  UPDATE "sessions" AS s SET "revokedAt" = moment.at FROM moment
  WHERE s."userId" = $2::uuid AND s."revokedAt" IS NULL AND s."expiresAt" > moment.at
  RETURNING s."id")
INSERT INTO "authentication_events" ("id", "userId", "eventType", "requestId")
SELECT <uuidv7>, $2::uuid, 'SESSION_REVOKED'::"AuthenticationEventType", CAST($3 AS text) FROM revoked
```

- **Exactly one event per session this statement revoked.** The rows come from `RETURNING` on the same
  `UPDATE`, so there is no earlier read or count to go stale. Under READ COMMITTED a row another transaction
  has revoked, or is revoking, is re-checked after that transaction ends and is not matched, so a session a
  logout revoked is reported by `LOGOUT` only. A data-modifying CTE always runs to completion.
- **One round trip, no application allocation.** Nothing per session is held in Node. The benchmarks show
  resident memory growth of at most 1.8 MiB at 100,000 sessions.
- **Fail-closed, atomic.** If the statement fails, the transaction aborts and nothing commits. A later
  failure (the `PASSWORD_RESET_COMPLETED` write) rolls the revocation and its events back too. Both are tested.
- **Unchanged.** The per-user advisory lock, the in-lock eligibility check, single-use token consumption, the
  credential compare-and-swap, the taxonomy, the schema, and session token handling.
- **Safety.** Every value is a bound parameter. The user id and request id pass through `sanitizedUuid`; the
  event type is a literal; no caller text reaches the SQL. The timestamp is passed as epoch milliseconds and
  converted in SQL because `sessions` stores a zone-less UTC `timestamp` and a `Date` parameter's rendering
  depends on driver time-zone handling; a test asserts the stored instant is exact. No new privilege is used:
  the same table and role as the ORM writes.
- **Deadlocks.** The statement locks only this user's session rows. Logout locks one of them. Neither takes
  locks in the opposite order, and the reset already serialises against login by the advisory lock. A
  deterministic test has a real logout hold a row while the reset runs.

### 16.3 UUIDv7 strategy

The schema's `@default(uuid(7))` is applied by the Prisma client, not the database. PostgreSQL here is 17.11,
which has **no `uuidv7()`** (added in 18) and no `pgcrypto`, but has `gen_random_uuid()` in core (since 13).
The identifier is built in SQL to the RFC 9562 layout: the 48-bit Unix-millisecond timestamp from
`clock_timestamp()` overlaid on the first six bytes of a random UUID, with the version nibble forced to 7
and the RFC variant kept from the random source. This is not a UUIDv4 substitute.

- **Verified** against the live database (version nibble `7`, variant `8`-`b`), and by tests that assert the
  pattern, distinctness, and that the embedded time falls inside the call's window, and that a client-made
  event id has the same pattern.
- **Control:** replacing the expression with `gen_random_uuid()` fails that test.
- **Difference from the client default:** ids are time-ordered to the millisecond but random within one
  millisecond, where the Prisma default also orders within a millisecond. Nothing orders or joins by this id
  (the index is `(userId, occurredAt)`), and the RFC permits it. A collision would violate the primary key and
  fail the statement and the reset, never write a duplicate; at 74 random bits per millisecond that is
  negligible even at 100,000 rows.
- **Portability:** requires PostgreSQL 13 or later. The infrastructure pins 17. The expression is not
  needed once the database offers `uuidv7()`, and replacing it would be a small, reviewable change.
- **No migration** and no database function was created.

### 16.4 Benchmarks

`apps/api/tests/benchmarks/reset-fanout.mjs` (not a test; run by hand). Windows 11 host, Docker Desktop,
PostgreSQL 17.11, one user, a real reset through the real service, the server-side sessions seeded by one
SQL statement. Times include the Argon2id hash (about 0.3 s) that runs before the transaction, so the
smallest sizes are dominated by it. Trials are independent users in the same database.

| Live sessions | Trials | Result             | Time ms, min / median / max | Revoked | `SESSION_REVOKED` rows | WAL MiB (median) | RSS growth MiB |
| ------------- | ------ | ------------------ | --------------------------- | ------- | ---------------------- | ---------------- | -------------- |
| 1,000         | 3      | ok                 | 299 / 332 / 336             | 1,000   | 1,000                  | 0.8              | 0.3            |
| 5,000         | 3      | ok                 | 491 / 589 / 754             | 5,000   | 5,000                  | 4.2              | 0.1            |
| 10,000        | 3      | ok                 | 690 / 845 / 971             | 10,000  | 10,000                 | 8.4              | 0.1            |
| 20,000        | 3      | ok                 | 1,166 / 1,226 / 1,325       | 20,000  | 20,000                 | 16.7             | 0.3            |
| 50,000        | 3      | ok                 | 3,542 / 4,196 / 4,860       | 50,000  | 50,000                 | 41.9             | 0.1            |
| 75,000        | 2      | ok                 | 3,301 / 3,396 / 3,396       | 75,000  | 75,000                 | 168.3            | 1.8            |
| 100,000       | 2      | ok                 | 3,751 / 3,888 / 3,888       | 100,000 | 100,000                | 92.1             | 0.3            |
| 150,000       | 2      | **fails**, `P2028` | 5,446 / 9,073 / 9,073       | 0       | 0                      | 135.9            | 0.2            |

Reference, same machine, **the accepted pre-Stage-2.7 behaviour** (revoke in one statement, no events), 2
trials: 10,000 in 0.38 s, 50,000 in 1.9 s, 100,000 in 3.8 s (min 2.9), and 200,000 one trial failed `P2028`
while the other succeeded in 7.0 s. The original per-row implementation (one trial): 10,000 in 3.2 s,
20,000 failed at 5.9 s.

How to read this:

- Every success revoked exactly the number of sessions it wrote events for, wrote exactly one
  `PASSWORD_RESET_COMPLETED`, and never timed out. Every failure committed nothing.
- **Scaling is roughly linear but noisy.** 50,000 took 3.5 to 4.9 s, against a 5 s timeout, while 75,000 and
  100,000 took 3.3 to 3.9 s. The spread comes from checkpoints, autovacuum and a host with little free memory.
  Do not read the 75,000 and 100,000 rows as faster than 50,000; read them as the same marginal region.
- WAL volume is not monotonic because a checkpoint inside a run adds full-page writes; it is a pressure
  indicator, not a measurement of the statement.
- **Honest summary.** There is comfortable headroom (about four times) up to 20,000 live sessions, a marginal
  region from 50,000 to 100,000, and failure by 150,000. The event write costs about 1.5 to 2 times the
  revoke-only statement. The boundary moved from about 15,000 to about 100,000+; the accepted boundary was
  100,000 to 200,000. One machine and few trials do not prove a universal limit.
- No transaction timeout was raised, and none should be raised to hide this.

### 16.5 Test lifecycle

**Finding.** When a test exceeds its timeout, vitest reports it and runs the teardown while the test body is
still executing. Requests the body had launched kept running, and each wrote its `LOGIN_FAILED` or
`LOGIN_SUCCEEDED` event after teardown had deleted that user's events. Teardown then deleted the user, hit
`ON DELETE RESTRICT`, and a user with six events was left behind. The original timeout was also hidden behind
that teardown error.

**Correction.** `tests/support/track-requests.mjs` is a setup file that wraps `fetch`. Every suite's teardown
now calls `settleRequests()` first, which refuses any request launched from then on and waits, bounded, for
those in flight. A stale test body therefore cannot start new work, and no row is deleted while the application
can still write one. Nothing is aborted mid-flight, because aborting a client does not stop the server-side
write. Cleanup remains scoped to rows the test owns. The 581 historical users, the residual user, and its six
events were not touched.

### 16.6 The 30-second integration timeout

**Not reproduced as a code regression, and not fully explained.** Observed twice, both times the _first_ run
after heavy activity: a full-suite run (that test took 55 s) and a single-file run (95 s, file 156 s). The
same test normally takes 3.6 to 5.2 s. Evidence gathered:

- **Repeated runs:** 14 further runs of the file, 6 of them with PostgreSQL polled every 2 s (101 samples), all
  passed in 3.6 to 5.2 s; the monitor never saw a backend waiting on a lock, a long transaction, or an active
  query during those runs. Runs on a database freshly churned by 150,000-row benchmarks passed too, so table
  bloat alone does not reproduce it.
- **Not a performance regression of the correction:** the stall also occurred around the per-row
  implementation, and the benchmarks show the reset itself is fast.
- **Not isolation or background-request leakage as the cause.** The leak was a consequence (section 16.5), not
  the trigger.
- **Most probable cause: host resource contention.** The test fires eight concurrent Argon2id verifications
  at 64 MiB each. The host had 1.0 GiB free of 15.8 GiB, with a 2 GB WSL VM, an editor, a browser and other
  agents running. A stall of that size is consistent with paging, but **this is not proven**.
- **No timeout was raised.** If it recurs, the settle step now reports how many requests were still pending,
  which separates a hung application from a slow host.

### 16.7 What remains

- A reset is still one transaction, so it still fails closed beyond a boundary near 100,000 live sessions on
  the reference machine. Sessions have no per-user cap and last 7 days, so the theoretical count remains above
  that. The failure is safe (nothing commits) and the account owner can retry after the attacker's sessions
  expire, but recovery can still be denied by an actor with a valid credential. Closing it fully needs a
  per-user session cap or a bounded revocation design, both **not approved**.
- `LOGIN_SUCCEEDED` volume is unchanged: bounded only by the global Argon2id budget.
- The events are set-based but still one row each; 100,000 sessions write 100,000 event rows in one reset.
- Requires PostgreSQL 13 or later for `gen_random_uuid()`.

---

## 17. State at the implementation commit

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
