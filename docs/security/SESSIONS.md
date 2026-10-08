# Secure session foundation - Stage 2.3

Internal primitives only, under apps/api/src/identity. No controller, HTTP middleware,
login/logout orchestration, cookie transport, JWT, refresh-token subsystem, CSRF,
mobile storage, reset workflow, event pipeline, tenant membership, or RBAC is added.
Stage 2.4 and later require separate owner authorization. The caller must authorize
session creation and revocation; possession of a user ID is not authorization.

## Secrets and persistence

Node crypto.randomBytes generates 32 independent random bytes (256 bits), encoded as
43 unpadded base64url characters. A bearer secret is separate from the Prisma UUID
Session ID and contains no user identifier or time. No injectable token generator or
reduced-cost test mode exists. Randomness failure raises a sanitized SERVICE_FAILURE.
Repeated-token tests check uniqueness/format, not a statistical proof of entropy;
the entropy guarantee rests on Node's CSPRNG and the 32-byte input size.

Only canonical encoding is accepted: exact type, length, alphabet, and round-trip
base64url check (including unused padding bits). No trimming or normalization. SHA-256
hashes the exact UTF-8 encoded token string; tokenHash is lowercase 64-character hex.
This is appropriate for high-entropy random secrets; Argon2id remains for passwords.
The existing unique tokenHash constraint remains authoritative. An improbable collision
fails closed as SERVICE_FAILURE rather than returning a token for another session.

createSession checks the current user exists and is ACTIVE, then generates a token,
persists only its hash and timestamps, and returns token/sessionId/expiresAt once.
There is no raw-secret retrieval operation. Neither token nor digest may enter logs,
errors, events, or analytics. Use the existing process-owned Prisma client with logging
disabled; do not enable credential query/parameter/error logging. No Redis storage.

## Lifetime and validation

SESSION_POLICY fixes lifetime at 604800000 milliseconds (seven days). Creation explicitly
sets createdAt and expiresAt using one sampled UTC-compatible Date. The service defaults
to the system clock; deterministic tests inject a clock without changing lifetime or
token generation. Invalid clock results fail closed. Operational clocks must be synchronized.
There are no environment overrides, sliding extensions, remember-me, refresh operations,
or cleanup worker. Expired records can remain in PostgreSQL without becoming valid.

Every validateSession invocation hashes the supplied token and queries the session and
current related user status. It rejects missing, revoked, expired, missing-user, or
non-ACTIVE identities. The clock is sampled after the database lookup and validity
requires now strictly less than expiresAt: equality is invalid. Validation returns
only userId/sessionId/expiresAt and never the secret, digest, or credential material.
lastSeenAt remains unchanged; validation does not write or depend on a write succeeding.
Updating lastSeenAt cannot extend lifetime or undo revocation.

Internal fixed SessionError codes distinguish INVALID_INPUT, INVALID_TOKEN,
SESSION_NOT_FOUND, SESSION_EXPIRED, SESSION_REVOKED, USER_NOT_FOUND, USER_DISABLED,
and SERVICE_FAILURE. Original database/crypto messages, stack traces, and causes are
not attached. Future public adapters must collapse invalid-credential distinctions
into a generic rejection and treat operational failures separately. No such adapter
is implemented here. Database failures never return an authenticated identity.

## Revocation and concurrency guarantees

revokeSession uses one atomic update filtered by session ID, expected user ID, and
revokedAt=null. Ownership is enforced in the write, never only in a preliminary read.
One concurrent revoker returns revoked=true; repeats return revoked=false without
changing the historical timestamp. Missing/cross-user IDs return SESSION_NOT_FOUND.
The follow-up ownership lookup is only for the idempotent result; it cannot authorize
a write. Revocation can mark an expired row, but cannot extend expiry or clear revocation.

revokeAllUserSessions uses one update filtered by userId, revokedAt=null, and
expiresAt greater than the sampled time. It returns only revokedCount, changes no other
user's rows, and preserves already-revoked/expired records. Concurrent revocations
remain conditional writes and cannot resurrect a session.

Explicit limitations (tested/documented, not stronger serialization claims):

- A user may be disabled after createSession's ACTIVE read but before its insert. That
  insert can succeed. Subsequent validation independently reads current account state
  and rejects the session while the user is disabled.
- Creation that commits outside revoke-all's update snapshot can survive revoke-all.
  This primitive is not yet a globally serialized sign-out-everywhere workflow.
- Validation reflects database reads during that call. Revocation/disabling completed
  before a new validation is observed; validation already in flight can race with them.
  The returned context is not a perpetual authorization grant for later operations.
- Disabling is not implicit revocation. Re-enabling can permit an otherwise valid,
  unrevoked session again; it never clears revokedAt or extends expiresAt. A later
  administrative workflow must explicitly revoke if permanent invalidation is desired.

A future atomic workflow should coordinate creation, revoke-all, and disabling with a
common per-user lock inside transactions, used by every participating writer. Another
option is a user session-generation/version checked on validation, requiring separate
schema approval. Neither strategy, administrative workflow, nor schema change is added
in Stage 2.3. Accepted migrations, Session indexes, and restrictive FKs are unchanged.

## Validation boundaries

Tests use runtime synthetic tokens, controlled timestamps without sleeps, and boolean
secret comparisons to avoid emitting token/hash diffs. Integration setup reuses the
existing guarded TEST_DATABASE_URL; there is no application-database fallback. Fixture
cleanup deletes only run-owned sessions/users, child first. Existing password and
foundation tests remain in the regression suite. Counts and command outcomes belong
in [the current handoff](../../tasks/CURRENT.md).
