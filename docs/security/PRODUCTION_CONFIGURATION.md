# Production configuration requirements (Stage 2.9)

The API and the worker validate their environment at startup. Outside production the local development fixtures
are accepted. When `NODE_ENV=production` the rules below apply, none is configurable, and a deployment that does
not meet them **does not start**. Errors name only the keys that failed; no supplied value, host, password or secret
is ever echoed. This is a statement about what the code enforces, not a claim that any deployment has been built:
production deployment is not authorised and no production topology is known.

## Requirements

| Setting                        | Requirement in production                                                                                                                                                                                                                                       | Why                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | Required in **every** mode, no default. Must be `development`, `test` or `production` exactly.                                                                                                                                                                  | The session cookie's `Secure` flag and `__Host-` name derive from it. A default of `development` meant a deployment that forgot it silently issued a plain, non-`Secure` cookie. |
| Session cookie                 | Derived from `NODE_ENV` (`__Host-` name, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). Not configurable.                                                                                                                                        | Unchanged from Stage 2.4. Requiring `NODE_ENV` and https origins is what guarantees it is the production cookie.                                                                 |
| `API_TRUSTED_ORIGINS`          | Every entry `https:` and not loopback (`localhost`, `127.*`, `[::1]`, `0.0.0.0`).                                                                                                                                                                               | A `Secure` cookie is never stored from an http origin, and a loopback origin is a development value.                                                                             |
| `API_RATE_LIMIT_HMAC_SECRET`   | Not a value committed to the repository, and not containing a development marker (`local_development`, `replace_in_production`, `tsms_local`, `changeme`, `example`). Existing length, alphabet and entropy rules still apply.                                  | The `.env.example` value is public.                                                                                                                                              |
| `API_HOST`                     | Must be stated explicitly.                                                                                                                                                                                                                                      | Listening on a non-loopback interface must be a decision, not a default.                                                                                                         |
| `DATABASE_URL`                 | `sslmode=verify-full` exactly once; no `uselibpqcompat`, no `ssl` flag, no differently cased `ssl*` parameter, no other `sslmode` spelling; a non-empty password that is not a repository development password. `sslrootcert`, `sslcert`, `sslkey` are allowed. | See the driver facts below.                                                                                                                                                      |
| `REDIS_URL`                    | `rediss:` scheme, no query string, a non-empty password that is not a repository development password.                                                                                                                                                          | See the driver facts below.                                                                                                                                                      |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Must not be `0`.                                                                                                                                                                                                                                                | It disables certificate verification for the whole process.                                                                                                                      |
| Web `TSMS_API_ORIGIN`          | `https:` unless it is a loopback address (unchanged since Stage 2.8).                                                                                                                                                                                           | The proxy forwards credentials and cookies.                                                                                                                                      |
| Secret provisioning            | Secrets are injected by a secret manager or the process environment. Never committed, never in a `NEXT_PUBLIC_` variable.                                                                                                                                       | Operator responsibility; the code cannot enforce it beyond rejecting known repository values.                                                                                    |

The worker applies the `NODE_ENV`, `DATABASE_URL`, `REDIS_URL` and `NODE_TLS_REJECT_UNAUTHORIZED` rules. Its bind
host keeps its loopback default.

### Production and test cannot be confused

- `NODE_ENV` must be exactly `development`, `test` or `production`; `prod` or `Production` are refused.
- **Test mode may only talk to loopback PostgreSQL and Redis** (both the API and the worker). Test mode issues the plain
  development cookie and the integration and browser suites delete rows and keys, so a production deployment started
  with `NODE_ENV=test`, or a test run pointed at a real service, is refused rather than allowed to proceed. Development
  mode keeps its freedom to use a shared remote service.
- The integration-test Redis guard now also requires a loopback host, as the database guard always has. It only
  required a non-zero logical database before, although those tests delete keys in it.
- The browser suite's own Redis setup requires a loopback host and a dedicated logical database.

## Why these transport rules and not simpler ones

TLS is only as strong as the client library's reading of the URL, and that reading was checked against the installed
versions rather than assumed (`packages/config/tests/transport-semantics.test.mjs` repeats the check on every run):

- **PostgreSQL** goes through `pg` 8.23.1 and `pg-connection-string` 2.14.1. With no `sslmode` the connection is
  plaintext, or follows a `PGSSLMODE` environment variable. `sslmode=no-verify` disables verification. With
  `uselibpqcompat=true`, `require` and `prefer` become unverified and `verify-ca` skips the hostname check. Only
  `verify-full` verifies the chain and the hostname without a footnote, so it is the only accepted mode.
  `sslmode=require` is deprecated in the driver and is being redefined to mean "do not verify".
- **Redis** goes through `ioredis` 5.11.1. A `rediss:` URL enables TLS with Node's default verification, because the
  client passes no `tls` options. URL query parameters are copied into the client options, so none is accepted.

If a library upgrade changes either reading, the cross-check test fails instead of the rule silently becoming
weaker. A certificate authority that is not public is supplied with `sslrootcert` (PostgreSQL) or
`NODE_EXTRA_CA_CERTS` (both), never by turning verification off.

## Verified against the drivers, not only the URL

`packages/config/tests/tls-enforcement.test.mjs` stands up local TLS servers with throwaway certificates and connects
through the installed `pg` and `ioredis` exactly as the application does, observing on the server side whether a TLS
session was ever established:

| Case                                                                        | Result                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Redis `rediss:`, certificate from an untrusted authority                    | handshake refused                                        |
| Redis `rediss:`, trusted authority, certificate for another name            | `ERR_TLS_CERT_ALTNAME_INVALID`, refused                  |
| Redis `rediss:`, trusted authority, correct name                            | handshake completes (control)                            |
| PostgreSQL `sslmode=verify-full`, untrusted or wrong name                   | refused, as above                                        |
| PostgreSQL `sslmode=verify-full`, trusted and correct                       | handshake completes (control)                            |
| no `sslmode`; `no-verify`; `require` or `prefer` with `uselibpqcompat=true` | **connect to an untrusted certificate, or use no TLS**   |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`                                            | connects to an untrusted certificate, with either driver |

Each weaker setting in the last two rows is refused by the production validator, and the test asserts both facts, so
every refusal is backed by a measured reason. The test needs `openssl` to mint the certificates; it is skipped with a
warning where that is missing and fails on CI.

## Development and CI

Every rule is skipped outside `NODE_ENV=production`, so local development and CI keep using the committed loopback
fixtures. `pnpm smoke` therefore starts the API and worker in test mode, and separately asserts that a production
start on those same fixtures is refused with the violated keys named and no value echoed, and that neither service
starts without `NODE_ENV`.

## Not covered

TLS for the hop between the Next.js web server and the API is a deployment matter (the web server requires an https
`TSMS_API_ORIGIN`); no ingress, certificate issuance, secret store or key rotation exists in this repository.

Expo's remote patch requirement is not enforced by CI, which checks compatibility offline. Before a production
deployment or store release, review `pnpm mobile:check:live` as described in
[MOBILE_COMPATIBILITY.md](../architecture/MOBILE_COMPATIBILITY.md).
