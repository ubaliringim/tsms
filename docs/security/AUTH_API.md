# HTTP authentication API - Stage 2.4

Status: authorized contract, implemented in `apps/api/src/identity/auth.*`. Global identity only.
No school, tenant, membership, role, or permission concept exists yet.

This document is the accepted-shape reference for the first public authentication surface. It
adds no authorization framework and no token issuance of its own: it adapts the accepted Stage 2.2
password credential primitive and the accepted Stage 2.3 session primitive to HTTP.

## Surface

| Method | Path           | Success              | Failure                                             |
| ------ | -------------- | -------------------- | --------------------------------------------------- |
| POST   | `/auth/login`  | `200` + session body | `400` malformed, `401` authentication, `403` origin |
| GET    | `/auth/me`     | `200` + session body | `401` unauthenticated                               |
| POST   | `/auth/logout` | `204`, empty body    | `403` origin                                        |

`POST /auth/login` and `POST /auth/logout` require a trusted `Origin` header. `GET /auth/me` does
not: it is not state-changing, and `SameSite=Lax` already prevents a cross-site request from
carrying the cookie. Requiring `Origin` on a safe method would break top-level navigation.

All three responses, including every failure, carry `Cache-Control: no-store` and `Vary: Origin`.
These are applied by a route-bound middleware before the handler runs, so they survive error
responses that Nest's own header decorators do not reach.

### POST /auth/login

Request: `Content-Type: application/json` (parameters such as `charset` are accepted) and a body
that is a plain object with exactly the two keys `email` and `password`, both `string`.

Any other shape - a JSON array, `null`, a missing or extra key, a number, an array, a boolean, or
`null` for either field - is a `400` with a fixed body that never echoes the submitted value.

`200` response body:

```json
{
  "user": {
    "id": "0196f4a2-1c3e-7a1b-9d55-6f0b2c8e4a10",
    "email": "person@example.com",
    "displayName": "Person"
  }
}
```

`id` is the `User.id` UUID, `email` is the stored presentation `email`, and `displayName` is the
stored display name. `normalizedEmail`, `status`, `emailVerifiedAt`, timestamps, credential rows,
session identifiers, token digests, and Argon2id parameters are never returned.

The bearer token appears **only** in a `Set-Cookie` header. It is never present in a JSON body, a
URL, a query parameter, a response header other than the cookie, an exception message, or a log
line.

### GET /auth/me

`200` with the same `user` object as login, resolved from the session cookie. No cookie, an
unparseable cookie, a cookie that is not a canonical Stage 2.3 token, an unknown session, an
expired session, a revoked session, or a non-`ACTIVE` user all produce the same `401` body. The
body does not distinguish those cases.

### POST /auth/logout

Revokes the session named by the cookie, then clears it. Always `204` with no body, whether or not
a valid session was present, so the response reveals nothing about whether a token ever existed.
The cookie is cleared with the same name, `Path`, and transport attributes used to set it.

Only the session identified by the presented cookie is revoked. There is no revoke-all endpoint
and no account-wide revocation route.

## Failures

Every authentication failure is one fixed body. The word "credential" is not used, because a
missing credential is one of the conditions it covers.

```json
{ "statusCode": 401, "error": "authentication_failed" }
```

Unknown email, wrong password, a `User` with no `PasswordCredential`, and a `DISABLED` `User`
produce a byte-identical status, body, and header set. Malformed input produces `400` with
`{ "statusCode": 400, "error": "invalid_request" }`; a body over the size limit produces `413` with
`{ "statusCode": 413, "error": "request_too_large" }`; a missing or untrusted `Origin` produces
`403` with `{ "statusCode": 403, "error": "forbidden_origin" }`.

Driver errors, stack traces, Prisma error codes, Argon2id failures, and connection details are
never returned. Malformed-JSON errors from the body parser are replaced wholesale, because the
upstream message can quote part of the submitted document.

## Cookie transport

The cookie carries the existing opaque Stage 2.3 token unchanged. The token is 43 unpadded
base64url characters, so it needs no escaping. No cookie-parsing dependency is added: the `Cookie`
header is parsed directly and narrowly.

| Attribute  | `NODE_ENV=production`     | development / test                       |
| ---------- | ------------------------- | ---------------------------------------- |
| Name       | `__Host-tsms_session`     | `tsms_session`                           |
| `HttpOnly` | yes                       | yes                                      |
| `Secure`   | yes                       | no (plain HTTP is loopback-only locally) |
| `SameSite` | `Lax`                     | `Lax`                                    |
| `Path`     | `/`                       | `/`                                      |
| `Domain`   | absent                    | absent                                   |
| `Max-Age`  | seconds until `expiresAt` | seconds until `expiresAt`                |

The name and `Secure` flag are derived from the already-validated `NODE_ENV`, not from a separate
toggle, so there is no configuration that can turn off `Secure` in production. `__Host-` requires
`Secure`, `Path=/`, and no `Domain`, and is used only where those hold. Development runs the API on
`127.0.0.1` over plain HTTP, where a `Secure` cookie would never be stored; that is the only reason
the development name differs, and it is explicit rather than a fallback.

Clearing sets an empty value, `Max-Age=0`, and an expiry in the past, with attributes identical to
the setting attributes.

The token is excluded from every URL, query string, `Authorization` header, log field, exception
message, and analytics payload. It is unreadable from JavaScript in the browser.

### Cookie parsing

Only the configured session cookie name is read. If the `Cookie` header carries that name **more
than once**, the request is treated as unauthenticated rather than resolved by first or last
occurrence: a duplicate is a browser-extension or cookie-tossing signal, and silently choosing one
would let an attacker-supplied cookie win. A missing, empty, or syntactically invalid cookie is
simply unauthenticated.

## Origin and CSRF policy

Authentication state lives in an automatically-attached cookie, so a cross-site request can cause
harm without the victim's knowledge. Login is included deliberately: _login CSRF_ forces a victim
into the attacker's account, and `SameSite=Lax` does not stop a top-level form or navigation
initiated by the attacker's page.

`API_TRUSTED_ORIGINS` is a comma-separated list of absolute origins, required in every environment,
validated at startup, and deduplicated. An entry is accepted only if it parses as a URL whose
scheme is `http` or `https`, whose host is non-empty, and which carries no credentials, path, query,
or fragment. Values are normalised to their origin form so scheme, host, and port compare exactly.

The guard compares the request `Origin` header to that list by exact string equality. It does not
derive the trusted value from `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Referer`, or any
other request header, because all of those are attacker-controllable unless a trusted proxy strips
and rewrites them, and this stage does not deploy behind one. It does not accept subdomains by
suffix, does not accept a wildcard, and does not fall back to same-origin inference.

`Origin` is **required** on the two state-changing endpoints. A missing header is a `403`, not a
pass: browsers attach `Origin` to every `POST` regardless of same- or cross-site, so requiring it
costs real clients nothing while closing the anonymous-client gap that a "reject only if present and
wrong" rule would leave. Non-browser clients must send an explicit `Origin`; this is documented
behaviour, not an accident.

`SameSite=Lax` plus the `Origin` check is defence in depth, not a single control: the cookie limits
which requests carry credentials, and the `Origin` check limits which of those requests the server
will act on.

Credentialed CORS is deliberately **not** configured. No `Access-Control-Allow-Origin` or
`Access-Control-Allow-Credentials` header is emitted, so a browser will not expose a cross-origin
response to credentialed `fetch` at all. The Stage 2.4 contract is therefore same-origin only. The
web and control applications run on different ports during local development, so wiring them to
the API requires a later, explicit credentialed allowlist decision that this stage does not make.

Residual risk and the intended direction are recorded under **Residual risk**.

## Enumeration and timing resistance

All four authentication-failure conditions share one response, so status codes, bodies, and headers
carry no signal. What remains is response _time_.

An unknown email, a user without a credential, and a `DISABLED` user do not skip verification: each
path performs an Argon2id verification against a fixed, repository-committed decoy digest with the
production parameters. A decoy is a hash of a random 32-byte string, so it corresponds to no real
account and no password can be derived from it. It exists only to make the failed paths cost what
the successful path costs.

A submitted password that violates the Stage 2.2 creation-time policy is rejected by the accepted
verification machinery before Argon2 runs. That happens identically on the real-credential and
decoy paths, so the two remain symmetric.

This is **not** a claim of constant-time HTTP authentication. `verifyPassword` returns before
Argon2 for a policy-invalid candidate, the database round trips are not equalised, network jitter
dominates on any real link, and an unbounded number of requests per client is not throttled at all.
What is claimed is that an observer cannot separate "no such account" from "wrong password" by
watching the cost of a single request. The remaining channel is repeated sampling, which is why
Stage 2.6 rate limiting is a deployment gate rather than a nicety.

### Rehash on login

`verifyPassword` reports `needsRehash`, and login ignores it. Transparent upgrade-on-login would
add a credential write to an endpoint whose accepted scope is authentication, and the parameters are
frozen. Parameter evolution stays an explicitly authorized follow-up.

## Input validation

Strict JSON only. `Content-Type` must be `application/json`. The body must be a plain object with
exactly `email` and `password`, both strings; unknown keys are rejected rather than ignored, so a
future field cannot be silently dropped by a client that believes it was accepted.

Email is trimmed and lowercased, and nothing else. No plus-address stripping, no dot removal, no
Unicode normalisation, no provider-specific rewriting - exactly the rule the `User.normalizedEmail`
column documents. It is bounded to 1-320 characters after trimming and must not contain ASCII
control characters. Full RFC 5322 syntax is deliberately not validated: the accepted database
documentation states that the database neither transforms nor validates email syntax, and inventing
a stricter parser here would reject addresses that could legitimately exist.

Passwords are never trimmed, case-folded, or normalised. Leading and trailing whitespace is
significant. No numeric, boolean, array, or object value is coerced to a string. The password
length is bounded by the 4 KiB request body limit rather than by the creation-time policy, because
login must not reject a stored password on creation-time grounds.

### Request size

The JSON body limit is 4 KiB, applied at the adapter, before parsing. An oversized body is `413`
with a fixed body.

## Logout concurrency

Logout revokes the session row and clears the cookie. A request that had **already** been
authorized before the revocation committed continues to completion: revocation is not a cancellation
and it does not reach into a handler that already holds a validated context. This is the ordinary
read-then-revoke window and it is not closed here. Requests authorized after the revocation sees it
fail. Only the presented session is revoked, so a second session belonging to the same user stays
valid, which is intentional.

## What is deliberately not implemented

No registration, password reset, email verification, recovery, refresh tokens, logout-all, session
listing, account management, tenant or school enrollment, role or permission assignment, JWT, or
client-side authentication state. `AuthenticationEvent` rows are **not** written: the accepted
Stage 2.2 and Stage 2.3 boundaries excluded event recording, so the login path stays read-only
apart from session creation, and event writing needs its own sanitized metadata contract.

A user is never created during login. No school is enrolled, no role assigned, and no temporary
password generated.

## Residual risk

- **No rate limiting.** Password verification is reachable over HTTP with no per-client or
  per-account throttle. This is the largest gap in this stage. Stage 2.6 owns full rate limiting and
  abuse protection; until it exists, exposure must stay behind a private network or an operator
  gate. **Stage 2.4 is not production-ready against credential stuffing or online password
  guessing**, and must not be exposed directly to the public internet.
- **Origin allowlist is not proxy-aware.** A deployment behind a TLS-terminating proxy terminates
  HTTPS itself; it must preserve the browser's `Origin` and must not be relied on to rewrite it.
- **Additional authenticated mutations will need more.** This stage protects exactly two
  state-changing routes with an exact-`Origin` check. A general double-submit CSRF token, bound to
  the session, is the intended approach for the wider authenticated surface, because `Origin`
  checking alone leaves gaps for clients that legitimately omit `Origin`. That mechanism is
  deliberately not built now: building a general CSRF framework ahead of the mutations that need it
  would be speculative.
- **Session fixation is narrowed, not eliminated.** A new session is created on every successful
  login, so a pre-login token is not carried forward, but no explicit rotation of an
  already-authenticated session's token occurs.
- **Cross-tab and cross-device logout.** Revoking one session does not affect the others belonging
  to that user.

## Validation boundaries

Tests boot the real application against the guarded `TEST_DATABASE_URL` and `TEST_REDIS_URL` and
drive it with the platform `fetch` and manual header control, because the browser's automatic
cookie jar cannot express duplicate or deliberately malformed cookies. Assertions read the database
directly to prove only a digest was persisted, and to build expired and revoked sessions without
sleeping. Fixtures use synthetic addresses, delete child rows before parents, and never fall back
to the application database.
