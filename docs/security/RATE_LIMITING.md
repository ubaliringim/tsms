# Authentication abuse protection - Stage 2.6

Status: implemented in `apps/api/src/identity/abuse-*.ts`, `apps/api/src/identity/client-identity.ts`,
`apps/api/src/identity/auth-abuse*.ts`, and `packages/redis/src/rate-limit.ts`. Locally validated,
**awaiting owner review**. Global identity only; no school, tenant, membership, role, or permission
concept exists yet.

This stage adds distributed abuse protection to the accepted Stage 2.4 and Stage 2.5 authentication
surface. It changes no credential, session, token, or recovery behaviour; it adds a refusal in front of
the routes that were previously unmetered.

## Threat model

The accepted stages closed enumeration and made guessing expensive per request. What remained was the
volume dimension: nothing stopped an attacker from making a million requests.

| Threat                                | Control                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| Credential stuffing from one source   | Login per-source meter                                         |
| Distributed guessing on one account   | Login per-account meter, keyed on the normalised address       |
| Repeated invalid credentials          | Same two meters, charged on failure rather than on attempt     |
| Argon2id resource exhaustion          | Global verification budget, charged where Argon2id is admitted |
| Free request flooding (malformed)     | Malformed-request meter, 30 per 5 min per source               |
| One account monopolising logins       | Per-account success meter, 10 per 10 min                       |
| Email flooding one victim             | Recovery per-target meter, charged on every request            |
| Recovery token brute force            | Reset per-token meter plus per-source meter                    |
| Recovery token-request abuse          | Recovery per-target meter, 3 per hour                          |
| Request flooding of cheap endpoints   | `me` and `logout` per-source meters                            |
| Redis-key reconnaissance              | Every subject is an HMAC; no raw identifier in a key           |
| Per-instance limit bypass             | All state is in Redis, shared by every API instance            |
| Forged client identity                | Transport peer only; every forwarding header ignored           |
| Protection loss during a Redis outage | Fail closed on login and both recovery endpoints               |

Out of scope by authorization: registration, MFA, CAPTCHA, account lockout columns, and
`AuthenticationEvent` recording (Stage 2.7).

## Endpoint policies

The numbers are conservative development defaults chosen against this system's actual costs. They are
**not** industry-standard guarantees and are not presented as protection against any particular
attacker. They live in reviewed source (`auth-abuse-policy.ts`), not in environment variables: an
operator who can raise a limit from a shell profile can also disable the control.

| Endpoint                     | Source (per address) | Target (per account / token) | Enforcement model |
| ---------------------------- | -------------------- | ---------------------------- | ----------------- |
| `POST /auth/login`           | 10 per 5 min         | 8 per 15 min                 | failures          |
| `POST /auth/password/forgot` | 5 per 15 min         | 3 per 1 h                    | requests          |
| `POST /auth/password/reset`  | 10 per 15 min        | 10 per 15 min                | failures          |
| `GET /auth/me`               | 120 per 1 min        | none                         | requests          |
| `POST /auth/logout`          | 30 per 1 min         | none                         | requests          |
| Global verification budget   | 120 per 1 min        | one key, whole deployment    | Argon2id admitted |
| Malformed request            | 30 per 5 min         | none                         | requests          |
| Successful login             | none                 | 10 per 10 min (per account)  | successes         |

Each bucket is a token bucket whose capacity is also its sustained rate, so there is no separate burst
parameter to misconfigure. Token bucket rather than a fixed window, so a client cannot send twice the
allowance by straddling a window boundary.

Argon2id costs 64 MiB and three passes, roughly 100 ms locally, and both login and recovery verify on
_ineligible_ requests too so that cost cannot be used as an oracle. The source limits are therefore set
far below what a person typing a password generates, while the per-account limits are tighter: one
person's typos must not consume a shared network's allowance.

**These meters are abuse controls, not a lockout.** They refill continuously, there is no lockout state
anywhere, and no account can be disabled by an attacker. An attacker who knows a victim's address can
cause that address temporary extra failures to be recorded, which is an inherent property of any
per-account meter and is documented rather than hidden. Legitimate typos self-correct within the window.

## Requests versus failures

Whether an endpoint meters every request or only failed attempts is a policy decision
(`countsEveryRequest`), and it differs for a substantive reason.

`login` and `reset` meter **failures**. Charging their successes would mean one busy office behind a
single NAT address exhausts a shared budget and lock out colleagues signing in correctly. That is a
self-inflicted denial of service, and it is the clearest evidence that a rate limit is not the same
thing as abuse.

`forgot` meters **requests**, and getting this wrong would defeat the control entirely: the abuse it
exists to stop is email flooding, and a flooding request _succeeds_ - it answers `202` and sends a
message. A failure-metered `forgot` would never limit anything, however many messages an attacker sent
to one victim. `me` and `logout` meter requests because they have no credential to fail.

## Admission reserves, outcomes refund

**This is the whole model, and it was corrected during the hardening review.**

The first implementation _checked_ the failure-metered dimensions at admission and _charged_ them after
the handler returned. That was intended to make a legitimate success free. It also meant the admission
decision and the charge were not atomic, so any number of simultaneous requests read the same untouched
bucket and all proceeded. The documented caveat "a burst can overshoot by the number of requests in
flight" was a real bypass, not a theoretical limitation.

Admission now **reserves** a token on every dimension, atomically, so simultaneous requests contend for real
state. The reservation is then settled by outcome:

| Outcome                          | Reservation        | Why                                                                   |
| -------------------------------- | ------------------ | --------------------------------------------------------------------- |
| successful login or reset        | **refunded**       | A correct sign-in must cost nothing                                   |
| `AUTHENTICATION_FAILED` (login)  | **kept**           | The guessing attempts the meter exists to count                       |
| `RECOVERY_TOKEN_INVALID` (reset) | **kept**           | Unknown, expired, consumed, superseded, or malformed token            |
| malformed body                   | **never reserved** | Metered on its own meter (Stage 2.9); there is nothing to return      |
| untrusted origin                 | **untouched**      | Refused by the origin guard before the abuse guard runs               |
| password-policy violation        | **refunded**       | Token was valid; nothing was guessed                                  |
| operational failure              | **refunded**       | Not an authentication attempt                                         |
| guard refusal (`429` or `503`)   | **untouched**      | The meter refused it and wrote nothing, so there is nothing to return |

The refusal set is exported as `CHARGED_ERROR_CODES` and asserted directly, so it cannot change silently
if a handler is refactored.

**Refund failures are swallowed.** The response has already been produced, and losing a refund costs that
caller one unit of its own allowance. Surfacing it would turn an ordinary wrong password into a `503`,
which is both wrong and a way to distinguish outcomes.

**The global verification budget is never refunded.** It measures work _started_, and returning it would
undo the bound on Argon2id work entirely. Since Stage 2.9 it is also not charged at admission: see below.

This is what makes "a legitimate attempt is free" an **enforced property** rather than an intention. A test
asserts that a full allowance of correct sign-ins is followed by a full allowance of metered failures, which
holds only if every reservation came back.

### Exact concurrency guarantees

- A burst of N simultaneous requests against a bucket of capacity C admits **at most C**. Asserted for login
  (20 requests against an allowance of 8) and reset (20 against 10), against real Redis.
- The same holds when the burst is split across **independently created API instances** sharing one Redis.
- Sequential and concurrent traffic are bounded identically. Concurrency changed the mechanism, not the limit.
- Legitimate traffic at or below the allowance is admitted outright, and its budget is restored.

## Stage 2.9 corrections (provisional)

A security review reproduced two defects in how the global Argon2id budget was spent, and a third in how login
success was limited. All three are corrected; the numbers below are provisional.

### What was wrong (reproduced, bounded, on isolated infrastructure)

- **Admission spent the global budget for requests that never hashed.** Admission reserved the credential meters
  and the global budget in one step. A request the controller then rejected as malformed had its credential
  reservations returned, but the global budget is never returned, so it was spent for nothing. One anonymous
  client sending about 2.7 malformed requests per second, with a trusted `Origin` header, kept the budget at zero:
  130 malformed logins drained it to 0.66 while the source bucket stayed full at 10, a correct login for an
  unrelated account then received `429`, and in a sustained run all 6 correct logins attempted received `429`.
  No Argon2id operation ran during any of it. The reset endpoint behaved the same.
- **Successful logins were free on every meter except the global budget.** One account looping logins at about 5
  per second created 195 sessions and 195 `LOGIN_SUCCEEDED` rows, left its source and account meters full, emptied
  the global budget, and caused a different user's correct login to be refused.
- Both are independent of the shared-source problem below: they hold with correct client attribution.

### What changed

| Change                                             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Global budget charged at the admission choke point | `Argon2idAdmissionService.acquire` charges one token, atomically, after the semaphore slot is granted and before any hashing. Every Argon2id operation passes through it, so there is exactly one charge per operation and none for a request that performs none. Admission only _checks_ the budget, so an exhausted budget still refuses cheaply with `429`.                                                           |
| Exhausted at the charge point                      | The slot is released, no hashing runs, and the request answers `429` with a bounded `Retry-After`. Redis failure still fails closed (`503`), and the slot is released on every refusal and every exception.                                                                                                                                                                                                              |
| Malformed-request meter                            | The guard decides whether a body is well-formed with the same function the controller uses (`parseAuthBody`), so the two cannot disagree. A malformed request is metered on one per-source bucket (30 per 5 min per endpoint) and on nothing else. It reserves nothing, so nothing is refunded for it, and it never names an account, so it cannot consume a victim's budget. It fails closed when Redis is unavailable. |
| Per-account success meter                          | A login that has just authenticated spends one token of a per-account bucket (10 per 10 min) before any session exists. A refusal therefore creates no session and no `LOGIN_SUCCEEDED` event. The token is returned if session creation then fails. Admission also checks it, so when an account is at its limit a wrong password and the correct one are refused identically. Failed attempts never touch it.          |
| Refund only what was reserved                      | The reservation interceptor refunds only when the guard recorded that a reservation was taken. Refunding a request that reserved nothing would credit the caller with tokens it never spent.                                                                                                                                                                                                                             |

### Properties and limits

- A single account can now create at most 10 sessions and 10 `LOGIN_SUCCEEDED` events per 10 minutes, rather than
  the global rate. This is a bound, not a cap on sessions: no per-user session cap, session cleanup, or idle
  timeout was added.
- Real hashing is still charged to the global budget, so one account can still spend at most its success allowance
  of it. Denying the whole deployment now needs on the order of 120 distinct accounts in a minute.
- Malformed traffic is bounded, not free: after 30 in 5 minutes from one source it is refused. Because the meter is
  separate, that never blocks a well-formed login from the same source.
- The 10 per 10 min and 30 per 5 min values are provisional development defaults, like every other number here.
- A refusal raised inside the handler (the budget emptying between the admission check and the charge) is a
  narrow race. For `forgot` it is swallowed rather than answered with `429`, because an eligible address performs no
  Argon2id and a `429` there would reveal that the address was ineligible.
- **The malformed-request meter is a per-source meter, so it inherits the shared-proxy attribution problem.** Behind
  the Next.js proxy every browser reaches the API from the web server's address, so all malformed traffic
  shares one bucket of 30 per 5 minutes: one client can exhaust it for everyone. Because the meter is separate, that
  only refuses further _malformed_ requests; it can no longer block a well-formed login, which was the effect of
  charging them to the login source meter. This is the same unresolved blocker as every other per-source meter, not a
  new one, and nothing here changes source attribution.
- Unchanged and still open: behind the Next.js proxy every browser shares one source address (the deployment
  blocker below). That is separate from these corrections, and none of them changes source attribution.

### Final inspection of the corrections

A second review of the corrections above, with tests on real PostgreSQL and Redis, established:

- **One charge per operation, and none for a request that hashes nothing.** A well-formed login whose password
  fails the password policy is rejected by the verifier before Argon2id runs, on every path alike. It originally still
  took a slot and spent a global token, which let a flood of short-password logins drain the budget without ever
  hashing. It now takes neither. The reset path validates the new password first for the same reason.
- **Concurrent requests cannot beat the budget.** With three tokens left, six simultaneous logins on six accounts
  produce exactly three successes and three `429`s with `Retry-After`; sessions and events number three, every
  reservation (including those of the refused requests) is returned, and every semaphore slot is released.
- **Slots are released on every exit**: a refusal by the budget, and an unexpected error from the charge itself.
- **A malformed request cannot buy back a token.** Two independent layers prevent it: the interceptor refunds only
  when the guard recorded a reservation, and the refundable-dimension function itself returns nothing for a
  malformed request.
- **Redis failure still fails closed**, at admission, at the semaphore, and at the charge.
- **The success meter cannot be over-credited**: a refund against an absent bucket creates nothing, and repeated
  refunds are clamped at capacity. Sixteen simultaneous charges against one account yield exactly ten.

**The success-meter refusal and oracles.** While an account is at its limit, the correct password and a wrong one
receive the same `429`, with the same body and `Retry-After`, in about 5 ms either way (measured locally, supplementary
only). The password is not consulted, so no credential oracle exists. Ordinary accounts and unknown addresses both answer
`401` in about 220 ms and are indistinguishable from each other. One signal remains and is documented rather than hidden:
an account at its own limit refuses quickly where an unknown address would not. It is not usable against an arbitrary
account, because only a holder of the password can fill the bucket, so it reveals nothing to anyone who does not already
control that account. A test pins it, so a change is a visible decision. Removing it would mean answering `401` for a
legitimate holder for up to a minute, which was judged worse and was not done.

## Bounded simultaneous Argon2id work

A per-minute budget bounds how much work may be _asked for_. It does not bound how much runs _at once_, and
with Argon2id at 64 MiB per operation that difference is the whole risk: a token bucket that starts full
hands out its entire capacity at once, so a 120-token budget permitted a 120-way burst of transient
allocations.

### Every Argon2id path reachable over HTTP

| Path                                       | Operation                   | Admission point                                                  |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| Login, active account with credential      | `verifyPassword`            | One slot around the whole verification                           |
| Login, unknown, disabled, or no credential | `verifyPassword` on a decoy | The same slot; enumeration resistance is preserved               |
| Recovery, ineligible request               | `verifyPassword` on a decoy | `PasswordRecoveryService.guarded`                                |
| Recovery, eligible request                 | none                        | No slot taken; a legitimate recovery never competes for capacity |
| Password reset, valid token                | `hashPassword`              | `guarded`, released **before** the transaction opens             |

Both services **require** the admission service as a constructor argument rather than accepting it as
optional: omitting it would silently remove the bound. `withArgon2idSlot` is the only supported way to
perform this work, and the slot is released in a `finally`.

### Mechanism

One Redis sorted set of lease holders. Each member is a **32-byte `randomBytes` holder id**, scored by its
expiry, with one Lua script per operation keeping it atomic.

- **Acquire:** prune expired members, refuse at capacity, otherwise add this holder and extend the key TTL.
- **Release:** remove only this holder, and only if it is present.
- **Renew:** extend only this holder, and only if still present.

Holder ids are never derived from a credential, address, or token, so one request can neither predict nor
forge another's slot.

### Why a Redis-backed lease is safe here specifically

A distributed semaphore is normally avoided because a crashed holder leaks capacity. That objection does not
apply to _this_ one: **every endpoint that can reach Argon2id already fails closed when Redis is
unreachable.** Adding a Redis-backed admission step therefore introduces **no new failure mode** - if Redis is
down, the request was already going to be refused before any Argon2id was attempted.

### Failure-mode analysis

| Failure                        | Behaviour                                                     |
| ------------------------------ | ------------------------------------------------------------- |
| Worker crash or `SIGKILL`      | Releases nothing; the lease expires and capacity returns      |
| Process termination            | Same                                                          |
| Redis disconnect mid-operation | Work completes; the release fails silently; the lease expires |
| Lease expiry while work runs   | Over-admission, bounded by the number of such holders         |
| Delayed release                | A no-op; the member is already absent                         |
| Duplicate release              | A no-op; cannot remove another holder's member                |
| Forged release of another's id | A no-op; ids are 32 random bytes                              |
| Concurrent acquisition         | Atomic; exactly `capacity` win                                |
| Multiple instances             | Shared: state is in Redis, not process-local                  |
| Redis unavailable              | Admission refused; **no unlimited fallback**                  |
| Timeout                        | Bounded at 750 ms, then refused as unconfirmable              |
| Malformed reply or clock       | Refused as unconfirmable; never treated as a granted slot     |

**Sizing.** 8 simultaneous operations is 512 MiB of transient allocation fleet-wide, roughly 80
verifications per second against a measured ~100 ms verification. Eight is chosen deliberately: the
accepted Stage 2.5 contract includes "concurrent valid logins are all admitted" and its suite exercises six
at once, so the bound must sit _above_ the legitimate concurrency of the product or it becomes the outage.

**Not a queue.** Admission is refused immediately rather than waited on, because waiting would hold request
bodies and connections in memory for an unbounded time.

### Limits of the concurrency bound

- **A lease that expires while its work is still running permits over-admission**, bounded by the number of
  such holders and not by request volume. The lease is 30 s against a ~100 ms operation and the holder renews
  every 10 s, so this needs an event-loop-starved process or a pathologically slow machine. It is stated
  rather than hidden, because a semaphore that claimed to be exact would be a worse claim than one that names
  its boundary.
- **Redis unavailability makes authentication unavailable**, because the bound cannot be confirmed. This is
  fail-closed by design and makes Redis a hard dependency for `login`, `forgot`, and `reset`.
- The renewal timer is one interval per in-flight operation, cleared on release and `unref`'d so it never
  holds the process open.

### Argon2id workload limits

The rate budget (120 per minute) and the concurrency bound (8 simultaneous) are separate controls answering
different questions, and both are charged before the allocation. Argon2id parameters are unchanged at 64 MiB,
t=3, p=1, 32-byte digest.

## Load-balancer identity

Transport-peer identity remains the only trusted source. `trust proxy` is still not enabled and still not
configurable.

**A TLS-terminating shared proxy collapses every client onto one address and therefore one source bucket.**
An attacker and a legitimate user behind the same gateway would share an allowance. Resolving this requires
an explicit, reviewed proxy-trust model naming the trusted hops - a decision this stage does not make.
**This stage is not production-ready behind such a proxy.**

## Rate-limit key secret

`API_RATE_LIMIT_HMAC_SECRET` is required in every environment and validated at startup: 32 to 512
characters, `[A-Za-z0-9_-]`, not a known placeholder, and not a single repeated character or short repeating
pattern. That last rule exists because a length check alone does not establish a secret: `'x'.repeat(32)`
satisfies any minimum length and carries almost no entropy.

The rule is deliberately narrow. It is **not** a claim to measure entropy and cannot be: real entropy comes
from the generator that produced the value, not from inspecting it. A legitimate hex-shaped secret
(`crypto.randomBytes(32)` rendered as hex) is explicitly accepted, because rejecting it would push operators
toward weaker values.

| Property                     | Status                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required everywhere          | Enforced; the API refuses to start without it                                                                                                                            |
| Validated length and class   | Enforced at startup, with accepted and rejected cases asserted                                                                                                           |
| Never logged                 | No logging path exists in the limiter, and the secret is never a log argument                                                                                            |
| Never committed              | Only a documented throwaway development value exists in `.env.example`; `.env` is ignored                                                                                |
| Used only for key derivation | It authorises nothing, is never sent to a client, and is not authentication material                                                                                     |
| Shared across replicas       | **Operational requirement, not verifiable by a test.** A per-instance value produces disjoint key spaces and silently turns a distributed limit into a per-instance one. |

**Rotation** changes every derived key, so rotating resets every active window and fails open for up to one
window. Rotate deliberately during a quiet period, keeping one value across all replicas throughout.

## Algorithm and atomicity

One Redis Lua script, `consumeRateLimit`, evaluates every dimension of one request in a single atomic
step.

- **Token bucket per dimension.** State is a two-field hash: scaled token count and last-refill
  timestamp. Refill is integer arithmetic, capped at capacity, with elapsed time clamped to one window
  so a clock jump cannot mint tokens.
- **Time comes from Redis `TIME`**, never from the caller. Every instance refills the same bucket at
  the same rate regardless of local clock skew, and no request can influence the clock.
- **All-or-nothing.** A request is admitted only when every dimension has capacity, and **nothing is
  written unless every dimension admits**. Charging one dimension while another rejects would let a
  caller drain an unrelated budget; this is asserted directly against a real Redis.
- **No `INCR`-then-`EXPIRE` window.** The script that creates a key also sets its expiry, so no crash
  can leave a key that never expires.
- **Commit vs check.** A dimension marked `commit: false` is evaluated and contributes to the decision
  and the retry calculation, but nothing is written. This is what separates the pre-flight admission
  test from the post-hoc charge for an attempt that turned out to fail.
- **One Redis command per decision**, carrying every dimension.

### Guarantees, and their limits

Claimed:

- Concurrent requests cannot exceed the allowance. Redis runs one script at a time, so the check and
  the write are indivisible. Twenty concurrent requests against five slots are admitted exactly five
  times, asserted against a real server.
- A key expires after exactly one window, which is also the time it takes to refill to capacity.
  Cardinality is bounded by distinct subjects seen within one window.
- Every key carries the `{tsms-rl}` hash tag, so a multi-key script stays inside one cluster slot if
  Redis Cluster is ever used.

Explicitly **not** claimed:

- **No strict fairness between dimensions.** Whichever reports the longest wait wins.
- **A lease that expires while its work is still running permits bounded over-admission** of the Argon2id
  concurrency bound. See **Limits of the concurrency bound**.
- **Redis Cluster is untested here.** The hash tag makes the keys slot-compatible; no Cluster instance
  was exercised.

## Trusted client identity

The transport peer is the only trusted address. `X-Forwarded-For`, `X-Real-IP`, `Forwarded`,
`CF-Connecting-IP`, `True-Client-IP`, `X-Client-IP`, `X-Original-Forwarded-For`, `request.ip`, and
`request.hostname` are all ignored unconditionally. They are client-supplied unless a proxy strips and
rewrites them, and none is deployed. Reading one would let any caller mint unlimited fresh identities
with a single header.

`trust proxy` is **not** enabled and there is no configuration to enable it.

Addresses are normalised so that one client cannot obtain several buckets by choosing a notation:

| Input                              | Normalised                   |
| ---------------------------------- | ---------------------------- |
| `203.0.113.10`                     | `203.0.113.10`               |
| `::ffff:203.0.113.10`              | `203.0.113.10`               |
| `::203.0.113.10`                   | `203.0.113.10`               |
| `2001:db8::1`, `2001:DB8:0:0::0:1` | `2001:db8::1`                |
| `[2001:db8::1]`                    | `2001:db8::1`                |
| `fe80::1%eth0` (scoped)            | rejected, one shared bucket  |
| unusable peer                      | `unknown`, one shared bucket |

An unrecognised or absent peer address collapses to a single shared bucket. Failing toward a shared
bucket is the safe direction: an unidentified caller gets a stricter limit, never a looser one.

**The NAT consequence, stated plainly.** A transport address is a network location, not a person. Every
device behind one home, office, campus, or carrier NAT shares a bucket, and one departing student can
exhaust the per-source allowance for everyone behind that gateway. Per-account and per-target meters
exist precisely because this control is coarse, and both are always applied alongside it. **No claim is
made that TSMS can identify an individual client.**

## Key privacy

Keys are `tsms:rl:v1:{tsms-rl}:<endpoint>:<dimension>:<128-bit hex HMAC>`, never a raw identifier.

The subject is an HMAC-SHA256 over a domain-separated message, truncated to 32 hex characters. Redis
keys are readable by anyone with operational access and are captured in keyspace dumps and backups; a
recovery token in a key would hand that person a live password reset.

- No raw email address, password, recovery token, session token, or password hash ever becomes key
  material. The reset target is the token's **SHA-256 digest**, which is what the token is compared by
  everywhere else too.
- `endpoint` and `dimension` are inside the message, not the key, so the same subject on two endpoints
  yields unrelated keys and cross-endpoint correlation is impossible from key material alone.
- Subjects longer than 512 characters are truncated rather than rejected, so response timing does not
  depend on submitted length.
- A 128-bit truncation collision would merge two subjects' budgets. That requires an intentional search
  and would at worst let one subject share another's allowance, never exceed it.

The secret is `API_RATE_LIMIT_HMAC_SECRET`, validated at startup: required in every environment, 32 to
512 characters, restricted to `[A-Za-z0-9_-]`, and rejected if it is a known placeholder. It is **not**
authentication material: it authorises nothing, is never sent to a client, and is never logged.

**Every API instance must share the value.** A per-instance secret produces disjoint key spaces, which
would silently turn a distributed limit into one limit per instance.

**Secret rotation** changes every derived key, so rotating it resets every active window. That fails
open for up to one window, which is the accepted cost; rotate deliberately rather than casually.

## Expensive-operation protection

Per-source and per-account meters do not bound total verification work: an attacker with many addresses
and many accounts stays under every local limit while still driving the CPU. A process-local counter
cannot help either, since each instance would allow its own share.

One global token bucket meters Argon2id verifications across the whole deployment, at 120 per minute,
enforced through the same atomic script and therefore shared across instances. It is charged
**unconditionally before the handler runs**, on every verifying endpoint, whether or not the attempt
succeeds - both an existing and a nonexistent account verify by design.

**This is a rate budget, not a concurrency semaphore, and the distinction matters.** It bounds how much
verification work the fleet can be _asked to start_. It does **not** bound how many verifications run
simultaneously: 120 starts per minute against a 100 ms verification permits roughly 0.2 concurrent, but
that is an arithmetic consequence, not an enforced bound, and a slow or contended machine could sustain
more in-flight work than intended.

A true simultaneous-verification cap needs leases with expiry and careful release semantics. A
half-built distributed semaphore is worse than an honest rate bound: it can deadlock or double-release.
**This is escalated as a real follow-up, not claimed as solved** - see residual risk.

## Redis outage behaviour

| Situation                             | Login / forgot / reset | `me`     | `logout`                    |
| ------------------------------------- | ---------------------- | -------- | --------------------------- |
| Redis unreachable before the request  | `503`                  | serve    | serve, revoke, clear cookie |
| Redis disconnects during the request  | `503`                  | serve    | serve, revoke, clear cookie |
| Redis command timeout (750 ms bound)  | `503`                  | serve    | serve, revoke, clear cookie |
| Redis command error                   | `503`                  | serve    | serve, revoke, clear cookie |
| Malformed or unrecognised Redis reply | `503`                  | serve    | serve, revoke, clear cookie |
| Redis recovers                        | enforced immediately   | enforced | enforced                    |

Fail-closed endpoints refuse **before** the handler, so no Argon2id is attempted and no recovery token
is issued while enforcement is unconfirmed. The response is the accepted fixed
`{ "statusCode": 503, "error": "service_unavailable" }`, identical to every other service failure, so a
client cannot distinguish a Redis outage from any other unavailability. An ioredis error message can
contain the connection password, so it is discarded rather than wrapped.

**A malformed reply is never treated as permission.** Only the two shapes the script produces are acted
on; anything else - wrong arity, wrong types, a negative wait, `null`, a string - is unconfirmable
enforcement and fails closed.

**Logout is not disabled by an outage**, and this is deliberate. Session revocation is a PostgreSQL
write in the accepted Stage 2.3 service; Redis only ever provided the throttle. An outage therefore
leaves revocation fully functional, the browser cookie is still cleared, and the `204` remains a
truthful claim: the session really was revoked. Refusing the request would mean a browser unable to log
out during a Redis incident. Reporting success while skipping revocation would mean telling a user a
stolen session is dead when it is not - and that cannot happen, because revocation runs and a genuine
revocation failure surfaces through the accepted `SERVICE_FAILURE` path exactly as in Stage 2.4.

A lost **failure charge** is also swallowed deliberately: the response is already produced, and losing a
charge costs one extra attempt next time. Raising it would turn an ordinary wrong password into a `503`,
which is wrong and would distinguish outcomes.

No circuit breaker was built. A broad breaker platform is outside this stage's scope.

## HTTP response contract

```json
{ "statusCode": 429, "error": "rate_limited" }
```

with `Retry-After` in whole seconds, clamped to **1..60**, rounded up so a retry never lands early.

- `Cache-Control: no-store` and `Vary: Origin` already apply through the accepted route middleware.
- The body does **not** vary by dimension, so a caller cannot learn whether its own source, its own
  account, or the deployment-wide budget ran out.
- No remaining count, no bucket identifier, no key material, no Redis detail, no internal counter.
- Enforcement failure uses the accepted `503 service_unavailable` body, never a distinct shape.

Unlimited endpoints, and every non-limit failure, keep their existing Stage 2.4 and Stage 2.5 contracts
byte for byte: `200`, `202`, `204`, `400`, `401`, `403`, `413`.

## Enumeration resistance

- The target meter keys on the **normalised address**, identical whether or not the account exists. No
  database lookup happens on the key path, so no existence signal can enter a key.
- **Recovery is metered by request, not by failure**, so an unknown and a known target consume budget
  identically. A failure-metered forgot would have made unknowns free and turned the meter into an
  oracle.
- A known and an unknown account return byte-identical status, body, and header sets at every position
  up to and including the refusal.
- A valid and an invalid recovery token produce the same `401`, and the same refusal once metered.
- A malformed address is not normalised, so no target dimension is built for it - but the source meter
  and the global budget still apply, so it is metered, never unmetered.
- A malformed token maps to a fixed shared subject, so guessing on unusable tokens is bounded.

**Not a constant-time claim.** As in Stage 2.4 and Stage 2.5, this is not constant-time execution, and
a distributed attacker can still separate eligible from ineligible paths by repeated sampling.

## Operational and performance review

- **Redis commands per authentication request:** one `TIME` and one `EVAL` for the meter, plus one `EVAL` for
  a refund on any outcome that is not a credential failure. `me` and `logout` are one `TIME` and one `EVAL`.
- **Commands per Argon2id operation:** one `TIME` and one `EVAL` to acquire, one `EVAL` to release, and one
  `EVAL` per renewal for work outliving 10 s. A refused acquisition costs the same two commands and stops.
- **Key cardinality:** one key per distinct (endpoint, dimension, subject) active within one window, plus
  **exactly one** key for the whole deployment's Argon2id semaphore. Bounded by distinct subjects in that
  window, not by total traffic.
- **TTL bounds:** bucket keys expire after exactly their policy window, between 60 s and 3,600 s. The
  semaphore key expires after twice its lease, so it cannot outlive its last possible holder.
- **Memory:** each bucket is a two-field hash on the order of 100 bytes plus Redis overhead; a deployment
  with N distinct subjects in the active window holds on the order of N keys. The semaphore holds at most
  `capacity` members - 8 - regardless of traffic.
- **Latency:** two to four extra round trips per protected request, each bounded at 750 ms. Against loopback
  Redis this is sub-millisecond; against a remote Redis it is the dominant added latency.
- **Behind NAT:** see above. Shared-address users share the source budget; per-account meters are the
  mitigation and are always applied.
- **Multi-instance guarantees:** total, because all state is in Redis and the enforcement is a single
  atomic script. Verified by two independently created application instances sharing one Redis, where
  the budget exhausted through one is refused by the other.
- **Argon2id limits:** two independent controls. The rate budget bounds work _started_; the leased semaphore
  bounds work _in flight_ at 8 across the deployment, with the residual lease-expiry caveat documented above.

## Tests

**Hardening regression suites, added by the review that found the bypass.**

_Concurrency probe_ (`apps/api/tests/rate-limit-concurrency.integration.test.mjs`, 6 cases): written **before**
the fix, to demonstrate the defect. Its assertions recorded the pre-fix observations verbatim and now assert
the corrected contract, so the before/after is preserved in the test file itself. It covers 20 concurrent
failed logins against an allowance of 8, 20 concurrent invalid resets against 10, a burst split across two
independently created applications, mixed successful and failed requests, and validation failures that never
reach a verification.

_Hardening suite_ (`apps/api/tests/rate-limit-hardening.integration.test.mjs`, 30 cases): the burst is bounded
for login and reset, and across separate instances; sequential traffic is bounded identically; a burst of
legitimate successes leaves the full allowance available; malformed submissions spend nothing; refunds never
manufacture budget; the concurrency bound holds under concurrent acquisition and across Redis clients; no
session is created by a refused request; capacity returns after a crashed holder; an expired lease cannot
revive a freed slot; a release cannot free another's slot; a duplicated release is a no-op; a late release
does not resurrect a key; malformed holder ids are rejected before any round trip; admission is refused when
Redis is unreachable with no fallback; and known and unknown accounts remain indistinguishable under
concurrency.

_Semaphore atomicity_ (`packages/redis/tests/argon2id-semaphore.integration.test.mjs`, 15 cases): capacity,
concurrent acquisition, growing held counts, expiry pruning isolated from the key's own TTL, self-reclaiming
capacity, renewal past the original lease, non-revival of a lapsed slot, release isolation, release
idempotency, sequential releases removing exactly one holder each, key removal on last release, one global
bound across three connections, release from a different connection than acquisition, and opaque holder
ids only.

_Hardening unit suite_ (`apps/api/tests/rate-limit-hardening.test.mjs`, 24 cases): semaphore key and holder
identity; the capacity floor that protects legitimate concurrency; lease and renewal ordering; the
concurrency bound being distinct from the rate budget; saturated versus unavailable classification; refusal
on unreadable replies and unreadable clocks; acceptance of the string clock Redis actually returns; limit and
lease validation; swallowed release and renewal failures; refund argument shape and swallowed failures; and
the reservation-versus-refund semantics.

_Secret validation_ (`packages/config/tests/rate-limit-secret.test.mjs`, 4 cases): required in every
environment; accepts what a secure generator produces, including hex-shaped; rejects absent, empty, too
short, too long, wrong class, placeholder, and entropy-free padded values; and never echoes a rejected value.

**Negative controls.** Three controls were run to confirm the tests actually detect the defects they claim:

1. **The concurrency bypass** was demonstrated before any fix: 20 concurrent failed logins were all admitted
   against an allowance of 8 (`{ admitted: 20, refused: 0 }`), as were 20 concurrent invalid resets against 10.
2. **The expiry prune**: removing `ZREMRANGEBYSCORE` left the original crash-recovery test green, showing it
   was passing because of the key's own `PEXPIRE` rather than because of the prune. The test was rewritten
   to force a single member's expiry into the past while the key is demonstrably still present, and it then
   failed with the prune removed. It now detects the defect.
3. **The all-or-nothing rule**: making a refused request write to every dimension fails 3 tests, including
   "writes nothing when one dimension refuses" and "still refuses a mixed set when only one dimension is
   exhausted".

**Original Stage 2.6 suites.**

**Unit, 61 cases** (`apps/api/tests/rate-limit.test.mjs`): policy validation and uniqueness; key
derivation; absence of raw emails and tokens in keys; single hash tag; per-endpoint key separation;
secret sensitivity; determinism; bounded oversized subjects; IPv4, IPv6, and IPv4-mapped IPv6
normalisation; scoped and malformed address rejection; transport peer versus eight spoofed forwarding
headers; `Retry-After` bounds and rounding; dimension composition and commit flags; request-versus-
failure classification; malformed replies; no leak of connection details in errors; and one-command
issuance.

**Integration, 37 cases** (`packages/redis/tests/rate-limit.integration.test.mjs`): exact capacity;
concurrency at the limit boundary; multi-dimensional atomicity; no write on refusal; subject isolation;
duplicate-dimension rejection; TTL set on first write; refill; key eviction; retry proportionality and
shrinkage; zero wait when admitted; unreachable Redis; bounded timeout; thirteen malformed replies; the
two accepted verdict shapes; error-message sanitisation; recovery; configuration validation including
duplicate keys, non-positive and fractional capacity, unbounded windows, and oversized capacity;
check-without-charge; and bounded key growth.

**Integration, 32 cases** (`apps/api/tests/rate-limit.integration.test.mjs`) against real Redis and
real PostgreSQL through the real HTTP application: login per-source and per-account limits; cross-user
isolation; concurrent burst then refusal; state shared across two independent applications; recovery
source and target limits; cross-target isolation; reset invalid-token and per-token limits; integrity
after refusal (credential unchanged, no token created, original password still works); `Retry-After`
behaviour; Redis-unavailable behaviour on all five endpoints including fail-closed before Argon2id, no
recovery token issued, `/auth/me` still correct, logout still revoking and clearing, readiness degraded,
and recovery once Redis returns; known-versus-unknown equivalence for login and recovery; token
validity never visible; eight spoofed forwarding headers ineffective; no session or credential write
after a refusal; and the preserved Stage 2.4 and Stage 2.5 contracts, origin matrix, body limits,
health endpoint, database isolation guards, and key namespace.

No test sleeps to wait out a window. Refill and eviction are observed by polling with a bounded deadline,
so a slow machine makes a test slower rather than flaky.

The pre-existing Stage 2.4 and Stage 2.5 suites reset only the accumulated rate-limit budget in
`beforeEach`, the same hygiene they already applied to their database fixtures. The real Redis, the
real script, and the real guard run in every one of those tests; only the accumulated budget is reset,
and each suite uses its own secret so key spaces cannot collide.

### Test isolation

The Argon2id semaphore is **one key spanning the whole deployment**, which is correct in production and
makes it shared state rather than a per-suite fixture. Two consequences had to be handled, and both were
found by running the full suite repeatedly rather than once:

- `apps/api` and `packages/redis` integration suites run against the same logical Redis database. The Redis
  suite additionally has an accepted Stage 1 test that calls `FLUSHDB` on that database. Running the two
  packages concurrently therefore deleted the semaphore and the rate-limit buckets out from under the API
  suites mid-assertion.
- The root `test:integration` script now runs `@tsms/redis` first and every other package afterwards, so
  the flush cannot overlap another suite. The Redis semaphore suite also uses its own key namespace, which
  does not weaken what it proves: the key is a namespace argument to the same three scripts, and the
  production default is exercised by the API suite.

Turbo cannot express a dependency from one package's task onto another's without also declaring it for
every package, which fails with `depends on itself`, so the sequencing lives in the root script. The
`FLUSHDB` assertion itself is unchanged and still proves that a flush is scoped to the logical database.
Three consecutive full runs are green.

## Preserved boundaries

Unchanged and asserted: Argon2id parameters (64 MiB, t=3, p=1, 32-byte digest); the password policy;
recovery token entropy, format, and 30-minute expiry; single-use consumption and supersession;
reset transaction atomicity; the shared per-user advisory lock and in-lock credential revalidation;
strict JSON validation and unknown-key rejection; the 4 KiB body limit; the trusted-origin check and
missing-Origin refusal; duplicate-cookie rejection; the decoy-digest enumeration defence; secure cookie
attributes; `Cache-Control: no-store` with `Vary: Origin`; the database and Redis disposable-test
guards.

No credentialed CORS. No registration. No schema or migration change. No dependency or lockfile change.
No `AuthenticationEvent` recording.

## Residual risk

- **The Argon2id concurrency bound has one residual gap.** Simultaneous verifications **are** now bounded at
  8 across the deployment, and a crashed holder's capacity is reclaimed by lease expiry. What remains is that
  a lease expiring while its work is still running permits bounded over-admission. The lease is 30 s against a
  ~100 ms operation with renewal every 10 s, so it requires an event-loop-starved process. **Recorded rather
  than hidden.**
- **Redis is now a hard dependency for authentication.** Login and both recovery endpoints cannot run without
  it, because neither the rate limiter nor the Argon2id concurrency bound can be confirmed otherwise.
  `/ready` already reports Redis.
- **Origin allowlist and client identity are both not proxy-aware.** Behind a TLS-terminating proxy every
  request shares one address and one source bucket, and the client address cannot be trusted either way.
  Resolving this needs an explicit reviewed proxy-trust model naming the trusted hops. Not decided here.
- **A refund that cannot be written is lost.** A Redis failure between a legitimate outcome and its refund
  costs that caller one unit of its own allowance. Bounded and self-correcting, but it means a correct sign-in
  is _nominally_ free rather than provably free under a partial outage.
- **Per-account meters are an availability risk by nature.** An attacker who knows an address can record
  extra failures against it. Refill is continuous and no lockout exists, so the effect is temporary, but
  it is real.
- **An IPv6 client with a large address space** could vary its address to obtain fresh source buckets.
  Normalisation collapses notations of one address but cannot collapse distinct addresses; only the
  per-account and global budgets constrain that case.
- **Secret rotation resets every active window**, failing open for up to one window.
- **Redis Cluster is designed for, not tested.** The hash tag makes keys slot-compatible; no Cluster
  instance was exercised.
- **No circuit breaker.** Repeated Redis unavailability produces repeated `503`s rather than a degraded
  mode, by design and out of scope here.
- **No security-event recording.** Rate-limit decisions are not persisted or alerted on; detecting abuse
  depends on Redis key state and operational monitoring. `AuthenticationEvent` is Stage 2.7.
- **Still open from earlier stages:** no production recovery email provider, so recovery remains unusable
  in production; deferred credentialed CORS; the broader CSRF design; per-user login serialisation
  during the short locked transaction; advisory-lock coordination covering only participating writers; and
  both high-severity advisories, `node-forge` GHSA-86w9-cpqp-85rv and `braces` GHSA-vfj7-8cjw-p6xm,
  which remain unresolved, installed, and unsuppressed.

## Deployment blockers

1. **A production `API_RATE_LIMIT_HMAC_SECRET` must be supplied as an injected random secret, identical
   across every replica.** Per-instance values silently break distributed enforcement.
2. **Redis availability becomes an authentication dependency.** Login and both recovery endpoints fail
   closed without it. The existing `/ready` probe already reports Redis, so a load balancer will stop
   routing before users see errors.
3. **No real email provider**, so password recovery remains unavailable in production regardless of
   rate limiting.
4. **Load-balancer policy must be decided.** A TLS-terminating proxy collapses all clients onto one
   source bucket. Either the API must learn the real client address through an explicit reviewed
   proxy-trust model, or the per-source meter must be re-tuned upward for the deployment.
5. **Limits are untuned development values.** They should be reviewed against real traffic and real
   school network topology before launch.

**This stage does not claim production readiness.**
