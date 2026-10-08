# Password credentials - Stage 2.2

Status: ACCEPTED / HOSTED VERIFIED / CLOSED (owner decision, 2026-10-08).
Stage 2 overall remains NOT ACCEPTED; Stage 2.3 is NOT STARTED / UNAUTHORIZED.

Scope: internal password primitives in apps/api/src/identity. These are not HTTP
authentication or onboarding. The caller must authorize credential provisioning and
replacement. No routes, Nest controller/module registration, session handling, reset
workflow, tenant membership, RBAC, pepper, external breach service, or password history.

## Dependency and runtime

Use exact argon2@0.45.1, the maintained Node binding to upstream Argon2. It supplies
asynchronous hash/verify, random salts, PHC encoding, and needsRehash without an auth
framework. Its declared Node >=16.17 support includes TSMS Node 24.16.0; cross-env's
Node 20+ requirement is also satisfied. Upstream release and security pages were
reviewed; registry audits before and after installation reported only the two existing
Stage 0 findings. This is not a guarantee of absence of undisclosed vulnerabilities.

The reviewed install command is cross-env ZERO_AR_DATE=1 node-gyp-build. A narrow
argon2 allowBuilds entry permits the upstream prebuilt binding check/source fallback;
strict peer, release-age, audit, and all other install restrictions remain intact.
Bundled Node-API native binaries support Windows x64 and Linux glibc/musl targets.
Unsupported targets require a compatible C/C++ toolchain and node-gyp prerequisites;
never copy Windows node_modules into Linux deployments. Generated binaries remain
ignored. Windows installation and hosted Linux installation/execution are verified.
[Run 37725238380](https://github.com/ubaliringim/tsms/actions/runs/37725238380) passed validate for commit
`cdf0ecd62565e9f1a0c0b701263e36c2e9092920`, including the password unit and integration tests.
Other deployment targets and native/store builds remain unverified.

The risk-register cross-cutting allowBuilds review trigger was evaluated: this single
new entry loads the password KDF, not certificate/signature verification or glob
processing. Existing node-forge/braces reachability, overrides, and dispositions are
unchanged. No audit exception or suppression was introduced.

References: [upstream release](https://github.com/ranisalt/node-argon2/releases/tag/v0.45.1),
[runtime/build support](https://github.com/ranisalt/node-argon2/tree/v0.45.1),
[security advisories](https://github.com/ranisalt/node-argon2/security/advisories).

## Policy

Accept strings of 15 through 128 Unicode code points inclusive. This supports long
passphrases without composition rules. Spaces, including leading/trailing spaces,
are meaningful. No trimming, case folding, normalization, or truncation occurs.
Combining marks count separately; astral characters count once. Reject lone UTF-16
surrogates because UTF-8 would otherwise silently replace them. Accepted UTF-8 input
is at most 512 bytes. Reject non-string/empty input deterministically. There is no
periodic expiration or password history. Validation returns only fixed reason codes.

## Production Argon2id configuration

ARGON2_PARAMETERS is immutable and not environment-overridable:

- Argon2id version 19 (0x13).
- memoryCost 65536 KiB = 64 MiB per operation.
- timeCost 3 iterations.
- parallelism 1 lane.
- hashLength 32 bytes.
- The library generates a fresh cryptographic 16-byte salt and standard PHC encoding.

These costs exceed the [OWASP minimum](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
of 19 MiB/two iterations/one lane. One lane bounds per-operation CPU parallelism;
64 MiB and three passes provide a meaningful offline cracking cost. Capacity planning
must account for concurrent native jobs and libuv workers. Later HTTP admission/rate
controls are not implemented here. No test override can silently reduce production
costs: tests exercise real costs, with explicitly weaker historical hashes only in
rehash fixtures. Local timings are recorded in tasks/CURRENT.md, not asserted in CI.

## Verification and parameter evolution

Use argon2.verify for comparison and argon2.needsRehash for version/memory/time/lane
comparison. The bounded PHC envelope also checks output length because needsRehash
does not. Verification returns only matches/needsRehash; the latter is true only after
successful verification. Hashing is the only low-level operation returning an encoded
hash; treat its output as secret persistence material, never an API response.

The envelope accepts this pinned library's canonical m,p,t serialization, versions
16/19, 8-64 byte salts and 16-64 byte outputs. Resource ceilings are 256 MiB, ten
iterations, and four lanes; minimum memory is eight KiB per lane. Noncanonical,
unsupported, corrupt or excessive-cost stored data produces VERIFICATION_FAILURE,
not mismatch or an unbounded native allocation. There is no cross-algorithm importer.
Change the reviewed envelope alongside future policy changes when necessary.

Invalid candidates return mismatch without native work. A policy increase must include
a review of verification compatibility for previously accepted passwords. Valid current
hashes return needsRehash=false. Older supported hashes can be verified and flagged;
no automatic write/login-triggered upgrade exists. Future upgrades call the current
hasher only after verification and must coordinate authorization and concurrency.

## Persistence and safe failures

PasswordCredentialService receives the existing process-owned Prisma client with
logging disabled. Never enable query/parameter/error logging on credential operations.
Creation hashes first, then inserts through Prisma; the existing FK and unique userId
constraint atomically enforce known user/one credential even under concurrent creates.
Only id, userId, and passwordChangedAt are returned. No schema/migration change.

Replacement reads the old credential, hashes outside a transaction, then performs one
atomic conditional update against id, old hash, and old timestamp. A concurrent
replacement/deletion returns CONCURRENT_CHANGE instead of silently overwriting data.
passwordChangedAt advances by at least one millisecond even within one clock tick;
Prisma maintains updatedAt. Session revocation and notifications belong to future
authorized orchestration, not this primitive.

Expected uniqueness/FK/not-found/concurrency failures have fixed service codes.
Unexpected driver failures map to PERSISTENCE_FAILURE; native failures map to
HASH_FAILURE/VERIFICATION_FAILURE. No original message, cause, candidate, or hash is
attached. No logging exists in these primitives. Callers must catch these operational
errors separately from a normal mismatch. No password or hash belongs in logs, event
metadata, snapshots, fixtures, or HTTP results. Test candidates are synthetic and
generated at runtime; assertions compare booleans to avoid credential diff output.
