# Web authentication (Stage 2.8)

Status: **IMPLEMENTATION COMMITTED / HOSTED VERIFICATION PENDING.** Implemented and locally validated; committed as one implementation commit for hosted
verification, whose result is **not yet recorded here**. **Not hosted-verified, not accepted, not closed, not deployed.**
Stage 2 overall is not accepted and Stage 2.9 is not authorized. This stage integrates the accepted Stage 2.1-2.7 API
contracts into the web application and changes none of them.

## 1. Decision: same-origin proxy, no CORS

Two designs were evaluated against the accepted contract.

| Question                             | A. Same-origin proxy (chosen)                                   | B. Direct browser to API, credentialed CORS                                          |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| API contract change                  | None                                                            | Adds `Access-Control-Allow-Origin` and `-Credentials`, which the accepted docs defer |
| Which origin sets the cookie         | The web origin                                                  | The API origin                                                                       |
| Cookie reaches API requests how      | Browser attaches it to web-origin requests; the proxy relays it | Browser attaches it to credentialed cross-origin `fetch`                             |
| Production cookie                    | `__Host-` cookie, host-only on the web origin, works unchanged  | Needs web and API on the same _site_; `SameSite=Lax` blocks it otherwise             |
| Needs an unknown production topology | No (the API stays private behind the web server)                | Yes: a shared registrable domain that nobody has chosen                              |
| Per-client rate limiting             | **Collapses to one source bucket** (see section 8)              | Preserved: the API sees the real peer                                                |
| CORS surface                         | None                                                            | A new allowlist that must be correct forever                                         |

A is the smallest design that leaves every accepted API control untouched, and the accepted documents already say the
contract is "same-origin only" and that credentialed CORS is "a later explicit decision". B would make that decision
without the owner. A's cost is real and is recorded as a production blocker in section 8, not hidden.

## 2. Request flow

```text
browser --(same origin)--> web  /api/auth/login   --> API POST /auth/login    sets the cookie
browser --(same origin)--> web  /api/auth/me      --> API GET  /auth/me       restores identity
browser --(same origin)--> web  /api/auth/logout  --> API POST /auth/logout   revokes + clears
```

- **Login.** The form posts JSON to `/api/auth/login` on the web origin. The Next route handler relays it to the API.
  The API creates the session and answers with `Set-Cookie`; the proxy passes that header through unchanged, so the
  **web origin** stores the cookie.
- **Subsequent requests.** The browser attaches the cookie to web-origin requests. The proxy forwards only the session
  cookie to the API.
- **Restoration.** On load the page calls `GET /api/auth/me`. `200` returns the profile; `401` is the API's single
  answer for a missing, expired, revoked, or disabled session.
- **Logout.** `POST /api/auth/logout` carries the cookie to the API, which revokes that one session and answers
  `204` with a clearing cookie.
- **No second session system.** The proxy holds no state, mints no token, reads no cookie value, and decides nothing.

Only these three paths exist. There is no catch-all proxy, so no other API route is reachable through the web origin.

## 3. What crosses the proxy

An allowlist in each direction. Anything not named is dropped.

| Direction      | Forwarded                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| browser to API | `content-type`, `origin` (verbatim), `cookie` (session cookie only, **never on login**), a fixed `accept` |
| API to browser | status, `content-type` (JSON only), numeric `retry-after`, session `Set-Cookie`, body                     |

Dropped on the way in: `Host`, `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Referer`, `Authorization`, `X-Request-Id`,
all other cookies, everything else. Dropped on the way out: `Server`, `X-Powered-By`, any `Access-Control-*`, any
`Set-Cookie` that is not the session cookie, any `Cache-Control` the API sent.

The proxy **never synthesises an `Origin`**. A hostile or missing `Origin` reaches the API unchanged and is refused
there. Redirects are never followed. A stalled API times out after 10 s. Every proxy response is
`Cache-Control: no-store`, `Vary: Origin`.

### Cookie forwarding, per route

| Route    | Cookie sent to the API                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `login`  | **none.** Login builds a session from credentials; an existing token would be handed over for no purpose |
| `me`     | the exact session cookie only                                                                            |
| `logout` | the exact session cookie only                                                                            |

Unrelated cookies are never forwarded. A repeated session cookie is forwarded as repeated, because the API deliberately
treats a duplicate as unauthenticated.

### Session `Set-Cookie` contract check

The proxy does not define the cookie contract; it refuses to carry a cookie that departs from the accepted Stage 2.4 one.
A session `Set-Cookie` is relayed only if it is exactly `HttpOnly; SameSite=Lax; Path=/; Max-Age=<n>` with no `Domain`,
no `Partitioned`, no unknown or repeated attribute, a token-shaped value, `Secure` whenever the name has the `__Host-`
prefix, and (for the clearing cookie only) a past `Expires`. Anything else is answered with the generic `503` and **no
cookie is set**, so the web origin can never store a session cookie weaker than the one the API's own tests assert.

### Streaming, byte-counted body limits

| Direction                    | Limit                                                   | How it is enforced                                               |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| browser to proxy (request)   | 4 KiB (the API's own limit)                             | streamed and counted in **bytes**; never buffered past the limit |
| API to proxy, `login` / `me` | 4 KiB                                                   | same reader                                                      |
| API to proxy, `logout`       | 1 KiB (a `204` normally; only an error body can appear) | same reader                                                      |

- A declared `Content-Length` over the limit is refused **before any byte is read**, and the stream is cancelled.
- A missing, chunked, or dishonest `Content-Length` changes nothing: the limit is applied to the bytes actually
  received, and reading stops and the stream is cancelled the moment it is exceeded.
- Multibyte text is counted in bytes, not UTF-16 characters (a body of 2,049 two-byte characters is over the limit
  although it is under 4,096 characters).
- Malformed UTF-8, a malformed `Content-Length`, and a stream error each give a fixed generic `400` (request) or `503`
  (response). No body content or error message reaches a response or a log.
- An over-limit upstream body is not an answer from this API and gives the generic `503`.
- After an oversized or abandoned body Node will not serve another request on that keep-alive socket until it closes;
  the server stays responsive on any new connection (tested). Browsers open a new connection, so this affects only a
  client that reuses a socket after sending an oversized body.

## 4. Origin, CSRF, and CORS

- **Trusted-origin enforcement is unchanged and stays in the API.** The browser's own `Origin` is forwarded verbatim
  and matched exactly against `API_TRUSTED_ORIGINS`. The web origin must therefore be in that list.
- **CSRF.** A cross-site `POST` to the web origin carries the attacker's `Origin`, which the API refuses with `403`,
  for login (login CSRF) and for logout. A missing `Origin` is also refused. This is the same defence-in-depth the API
  already has: `SameSite=Lax` limits which requests carry the cookie, and the exact-`Origin` check limits which the
  server acts on. `GET /auth/me` changes nothing and its answer is not readable cross-origin.
- **No double-submit CSRF token is added.** The two state-changing routes are covered by the `Origin` check. A general
  token remains the intended approach for the wider authenticated surface and is not built ahead of the mutations that
  need it, as the accepted API document already records.
- **CORS is not enabled and not required.** The browser never makes a cross-origin request. No `Access-Control-*`
  header is emitted by the web server or reaches the browser from the API; a test asserts this, including for a
  preflight.
- **Forwarded headers are not trusted.** `X-Forwarded-Host`, `Forwarded`, and `Referer` cannot launder an untrusted
  `Origin` (tested).

## 5. Cookie transport

Unchanged from Stage 2.4: opaque server-issued token, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, `Max-Age`
bounded by the session expiry; `Secure` and the `__Host-tsms_session` name in production, `tsms_session` on plain-HTTP
loopback in development. The token never appears in a body, a URL, a log, or JavaScript. Nothing is stored in
`localStorage`, `sessionStorage`, or IndexedDB; a test scans browser-side code for them.

In production the **web origin must be served over HTTPS**, or the browser will refuse to store a `Secure` / `__Host-`
cookie. The `__Host-` prefix works because the proxy returns the API's `Set-Cookie` with no `Domain`.

## 6. Browser behaviour

| State             | Meaning                                     | Shows                                            |
| ----------------- | ------------------------------------------- | ------------------------------------------------ |
| `restoring`       | `/me` not answered yet                      | "Checking your session..." only; no identity     |
| `unauthenticated` | API said `401`                              | Sign-in form                                     |
| `unavailable`     | Network failure, 429, 5xx, malformed answer | "This does not mean you were signed out" + retry |
| `authenticated`   | API returned a profile                      | Shell with name, email, Sign out                 |

- A network failure is **never** treated as proof of sign-out. A failed re-check of a confirmed session keeps it.
- A confirmed `401` on re-check drops the identity and says the session ended.
- Logout reports success only on the API's `204`. On any other outcome the shell stays, with an alert that sign-out
  could not be confirmed. `pageshow` from the back/forward cache re-validates the session.
- Login failures use one message for an unknown address, a wrong password, and a disabled account; a rate limit, an
  invalid request, and an outage have their own generic messages. The password field is cleared after every attempt.
- The form is `method="post"`, so a native submit could never place credentials in a URL. Labels, focus handling,
  `role="alert"` / `role="status"`, 44 px targets, and a narrow-screen layout are provided.
- **The gate is presentation, not access control.** Authorization remains the API's, on every request.
- Pages send `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

## 7. Configuration

| Variable                    | Read by    | Development                  | Production                                                 |
| --------------------------- | ---------- | ---------------------------- | ---------------------------------------------------------- |
| `TSMS_API_ORIGIN`           | web server | defaults to `127.0.0.1:4000` | **required**; missing or malformed fails closed with `503` |
| `API_TRUSTED_ORIGINS` (API) | API        | must include the web origin  | must list the real HTTPS web origin and nothing else       |

`TSMS_API_ORIGIN` has no `NEXT_PUBLIC_` form, so a browser can never be pointed at the API. It must be a bare origin
(no credentials, path, query, or fragment) and must be `https` unless it is a loopback address. Next.js reads it from
the process environment or `apps/web/.env*`, not the repository root `.env`. Failures never echo the configured value.
`pnpm smoke` asserts that a production web server with no upstream fails closed.

Development: API on `127.0.0.1:4000`, web on `127.0.0.1:3000`, and the default `API_TRUSTED_ORIGINS` already lists the
web origin. Open `http://127.0.0.1:3000`; do not use `localhost`, which is a different origin to the allowlist.

## 8. Remaining risks and unresolved assumptions

1. **Client identity collapses behind the proxy (production blocker, owner decision).** The API identifies clients by
   transport peer only and ignores forwarded headers by design (Stage 2.6). Through this proxy every browser reaches the
   API from the web server's address, so the per-source meters (login: 10 per 5 minutes) become **one shared budget for
   all users**. That bounds abuse but lets one client exhaust sign-in for everyone, and the per-account meters are then
   the only per-target control. The documented remedies are an explicit reviewed proxy-trust model, or retuned limits.
   Neither is decided here and neither is implemented.
2. **Production topology, ingress, and TLS termination are unknown and unproven.** Nothing has run on a real host,
   behind real TLS, or with a real domain, and no deployment has occurred. A non-loopback API origin must use HTTPS
   (enforced); who terminates TLS and which client address the ingress can supply are undecided.
3. **Browser coverage is Chromium only and local only.** The suite in section 11 ran in an installed Google Chrome over
   loopback HTTP. It does not cover TLS, the `Secure` / `__Host-` production cookie in a browser, Firefox or Safari,
   or assistive-technology output beyond roles and focus. A hosted HTTPS verification is still required.
4. **The Content-Security-Policy is partial.** It has no `default-src`, `script-src` or `style-src`, so it is **not** an
   XSS defence. A safe `script-src` is an owner decision (section 12).
5. **No session-expiry timer.** An expired session is discovered on the next load or `pageshow`, not while idle.
6. **Redis remains a hard dependency for login**, and the Stage 2.6 HMAC provisioning and threshold limits still apply.
   There is also **no real email provider**, so password recovery stays unavailable in production.
7. **Dependency advisories remain open and unsuppressed:** node-forge `GHSA-86w9-cpqp-85rv`, braces `GHSA-vfj7-8cjw-p6xm`.

## 9. Explicitly deferred

Registration, password-recovery screens, school membership and RBAC, role-specific interfaces, remember-me, refresh
tokens, logout-all and session lists, a double-submit CSRF token, a script-restricting CSP (owner decision), idle-expiry handling, internationalisation,
analytics, and any decision on proxy trust or client identity.

## 10. Testing evidence (local)

| Layer                                 | Count | What it proves                                                                                                                                                                                                                                                    |
| ------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/api-origin.test.ts`            |    12 | Production never falls back to a development upstream; HTTPS rule; malformed values rejected                                                                                                                                                                      |
| `tests/auth-proxy.test.ts`            |    18 | Request and response allowlists, verbatim `Origin`, cookie filtering, redirects, timeouts, no-store                                                                                                                                                               |
| `tests/auth-proxy-limits.test.ts`     |    36 | Streaming byte limits (chunked, no length, lying length, multibyte, malformed UTF-8, stream error), response caps, per-route cookie forwarding, the `Set-Cookie` contract                                                                                         |
| `tests/auth-client.test.ts`           |    25 | Outcome classification: a network failure or 5xx is never "signed out"; logout confirms only on `204`                                                                                                                                                             |
| `tests/session-state.test.ts`         |    10 | Identity exists only while authenticated; transient failure keeps a session; unconfirmed logout stays signed in                                                                                                                                                   |
| `tests/interface.test.tsx`            |     8 | First render has no identity; labels; POST form; generic messages; no storage or logging in browser code                                                                                                                                                          |
| `tests/web-auth.integration.test.mjs` |    25 | Real chain: cookie attributes, no token exposure, generic failures, 429 relay, CSRF, forged `Origin`, forwarded-header laundering, no CORS, expiry, disabled user, logout revocation, outage, log content, oversized and malformed bodies through the real server |
| `e2e/auth.spec.mjs` (real browser)    |    16 | Section 11                                                                                                                                                                                                                                                        |

### Negative controls

Each mutation below was applied to `auth-proxy.ts`, the unit suite was run, and the file was restored byte-for-byte.
Every mutation made tests fail, so each assertion is sensitive to the behaviour it names.

| Mutation                                                                   | Tests failing |
| -------------------------------------------------------------------------- | ------------: |
| Request limit never enforced (chunked, no length, lying length, multibyte) |            11 |
| Request bytes counted as characters                                        |             1 |
| Declared `Content-Length` ignored                                          |             1 |
| Upstream response cap removed                                              |             5 |
| Login forwards an existing session cookie                                  |             2 |
| Proxy launders `Origin` from the request URL                               |             2 |
| Session cookie contract not enforced                                       |             1 |

Earlier, making the proxy synthesise `Origin` failed 9 of the then 21 integration tests. The refusal of an untrusted
`Origin` itself is the API's behaviour and is asserted end to end in the integration and browser-adjacent suites.

Integration suites that share the Redis rate-limit namespace cannot run concurrently, so turbo orders
`@tsms/web#test:integration` after `@tsms/api#test:integration`. The browser suite uses its own Redis logical database
(`E2E_REDIS_DB`, default 2), so it can reset the limiter without touching that state.

## 11. Browser suite

`pnpm test:e2e` (turbo, builds first) or `pnpm --filter @tsms/web test:e2e`. It needs a production build, the Docker
Compose PostgreSQL and Redis, and a browser: Playwright's bundled Chromium (`pnpm --filter @tsms/web exec playwright
install chromium`), or an installed Chrome with `E2E_BROWSER_CHANNEL=chrome`. It is **not** part of `pnpm check`,
`pnpm test`, `pnpm test:integration`, or the hosted workflow, because it needs a browser download.

A real browser drives the production `next start` in front of the real API, PostgreSQL, and Redis. Each test creates its
own synthetic users and removes only them. Reports and traces go to `test-results/` and `playwright-report/`, both
ignored by Git.

| Area                   | Covered                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                  | Sign-in; `HttpOnly`, `SameSite=Lax`, `Path=/` cookie; no token in `document.cookie`, web storage, or the URL                                                     |
| Restoration            | Refresh restores the session; a held `/me` shows only "Checking your session" with no identity, form, or sign-out control                                        |
| Logout                 | Session revoked in the database; "signed out" notice; navigating away and back, and a reload, show no identity                                                   |
| Expired / revoked      | Expired session after reload shows the form; a revoked session found on a `pageshow` re-check shows "session has ended"                                          |
| Failures               | One generic message for wrong password and unknown address; real limiter 429 message; outage then retry restores the session; unconfirmed logout stays signed in |
| Keyboard               | Tab order email, password, button; Enter submits; visible focus outline; sign-out by keyboard                                                                    |
| Focus and announcement | Error in a `role="alert"` region linked by `aria-describedby`; focus returns to a cleared password field; busy and disabled state                                |
| Layout                 | 360 px and 1280 px, signed out and in: no horizontal overflow, fields inside the viewport, 44 px controls                                                        |
| Policy                 | Security headers present; CSP directives present with no `unsafe-*`; no `securitypolicyviolation` while signing in                                               |

**Needs a hosted HTTPS environment:** the `Secure` and `__Host-` production cookie in a browser, HSTS and ingress headers,
TLS behaviour of the API hop, other browsers, and the real client-address path.

## 12. Content-Security-Policy

**Implemented (partial):** `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self';
connect-src 'self'`, sent with `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`. None of these touches script execution, so none can break hydration; the browser suite
asserts the application works and reports no violation under it. It has **no `default-src`, `script-src`, or
`style-src`**, and the header comment in `next.config.ts` says so. It is a framing and injection-hardening subset, not an
XSS policy.

**Not implemented, and why.** The production page contains three inline scripts and no inline styles:

1. the Turbopack chunk bootstrap (about 200 bytes),
2. `self.__next_f=...push([0])` (about 40 bytes), and
3. the RSC payload (about 4 KB), whose content changes with every build and every route.

A `script-src` that excludes `'unsafe-inline'` therefore needs one of:

| Option                                         | Effect                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nonce per request (Next's documented approach) | Every page must be rendered dynamically on each request; static optimisation is lost. Needs a `proxy.ts`. Production needs no `unsafe-eval`.                                                                                   |
| Hash of each inline script                     | The hashes exist only after the build, and Next evaluates `headers()` before it. It needs a post-build step that rewrites the routes manifest, and it breaks whenever a page is added or the payload changes. Not recommended. |
| Leave `script-src` unset (current)             | No XSS mitigation from CSP; the pages hold no authenticated data and the session token is `HttpOnly`.                                                                                                                          |

Adding a nonce is a material architectural change (static to dynamic rendering for the whole application), so it was not
made. **Owner decision required** before a script-restricting CSP. `'unsafe-eval'` is needed only by React in
development, and `'unsafe-inline'` is not needed with nonces.
