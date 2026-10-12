/**
 * Stage 2.7 - canonical security event vocabulary.
 *
 * ## Why this file is an allowlist and not a convenience type
 *
 * `AuthenticationEvent` has exactly four writable columns: `eventType`, `userId`, `occurredAt`, and
 * `requestId`. There is deliberately no metadata column, no source-address column, and no free-text
 * column. That is the single most important privacy property of this stage, and it is structural rather
 * than procedural: a caller cannot attach a payload to an event because the type has nowhere to put one.
 *
 * So the allowlist here is enforced by the type system and by the parameter list of the recorder, not by
 * a runtime filter that a future author might forget to update. If a future stage needs richer events,
 * that is a schema decision requiring owner authorization - not a new field on this interface.
 *
 * ## What is deliberately never recorded
 *
 * Passwords, recovery tokens, session bearer tokens, cookie values, `Authorization` headers, password
 * hashes or their fingerprints, normalized email addresses, Redis keys, HMAC inputs, and raw driver
 * errors. None of them have a column, and none of them have a parameter.
 */

/** The Stage 2.1 `AuthenticationEventType` values this stage is able to write truthfully. */
export const SECURITY_EVENT_TYPES = [
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGOUT',
  'SESSION_REVOKED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/**
 * The three accepted enum values this stage deliberately leaves unused.
 *
 * They are recorded here so a later author does not "helpfully" wire them to the wrong moment:
 *
 * - `PASSWORD_CHANGED` and `ACCOUNT_DISABLED` describe state changes performed by an actor. No such
 *   action exists yet: there is no password-change endpoint and no account-disable endpoint. Emitting
 *   `ACCOUNT_DISABLED` when a login is merely *refused* on a disabled account would assert that a
 *   disablement happened, which did not.
 * - `EMAIL_VERIFIED` describes an action that does not exist, because there is no registration path.
 */
export const RESERVED_EVENT_TYPES = [
  'PASSWORD_CHANGED',
  'ACCOUNT_DISABLED',
  'EMAIL_VERIFIED',
] as const;

/**
 * Endpoints a security event can be attributed to.
 *
 * This is the same closed set the Stage 2.6 abuse policy uses, so a denial on one endpoint cannot be
 * mislabelled as another.
 */
export const SECURITY_EVENT_ENDPOINTS = ['login', 'me', 'logout', 'forgot', 'reset'] as const;

export type SecurityEventEndpoint = (typeof SECURITY_EVENT_ENDPOINTS)[number];

/**
 * UUID v4, canonical lowercase hyphenated form.
 *
 * Applied to `userId` and `requestId` before they are persisted. The database would accept any string
 * in a `String?` column, which is precisely why the check belongs here: these two columns are the only
 * caller-influenced values in the table, and an unbounded string in `requestId` is how a request header
 * eventually ends up in an audit row.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normalise an identifier to a canonical UUID, or `undefined`.
 *
 * Returns `undefined` rather than throwing: a malformed correlation id must never turn a completed
 * authentication into a 500. Dropping the field degrades correlation; rejecting the request would be
 * strictly worse.
 */
export function sanitizedUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Narrow an arbitrary value to a known event type.
 *
 * `undefined` for anything unknown, so a typo becomes a silent no-op on an internal path rather than a
 * fabricated security record. Callers on request paths treat this as "do not record", which is the safe
 * direction: a missing audit row is recoverable, a false one is not.
 */
export function securityEventTypeOf(value: unknown): SecurityEventType | undefined {
  return typeof value === 'string' && (SECURITY_EVENT_TYPES as readonly string[]).includes(value)
    ? (value as SecurityEventType)
    : undefined;
}

/**
 * Narrow an arbitrary value to a known endpoint.
 *
 * Used for structured logging, where the field is present but free-form would let an unexpected route
 * string become unbounded log content.
 */
export function securityEndpointOf(value: unknown): SecurityEventEndpoint | undefined {
  return typeof value === 'string' &&
    (SECURITY_EVENT_ENDPOINTS as readonly string[]).includes(value)
    ? (value as SecurityEventEndpoint)
    : undefined;
}
