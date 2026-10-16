/**
 * The shape of an authentication request body - Stage 2.9.
 *
 * One definition, used twice. The controller uses it to refuse a malformed request, and the abuse guard uses it to
 * decide, **before** anything is reserved, whether a request is a candidate authentication attempt or is
 * malformed. Because both call this function, they cannot disagree: a request the guard meters as well-formed can
 * never be rejected by the controller for shape, and a request the guard meters as malformed is always rejected
 * by the controller.
 *
 * That agreement matters for the abuse meters. A malformed request performs no Argon2id and is not an attempt to
 * authenticate, so it must not spend the global Argon2id budget or the credential meters (which would let anyone
 * drain them for free), yet it must not be free either. The guard therefore routes it to its own small per-source
 * meter. If the two definitions could drift, a request could slip between the meters.
 *
 * The function inspects structure only. It reads no account state, so it cannot become an existence oracle.
 */

export type AuthBodyKind = 'login' | 'forgot' | 'reset';

const REQUIRED_KEYS: Readonly<Record<AuthBodyKind, readonly string[]>> = {
  login: ['email', 'password'],
  forgot: ['email'],
  reset: ['token', 'newPassword'],
};

/** Bounded recovery input. Both fields are short, bounded strings; nothing else is accepted. */
const MAX_RECOVERY_TOKEN_LENGTH = 128;
const MAX_EMAIL_LENGTH = 320;

const JSON_CONTENT_TYPE = /^application\/json\s*(;.*)?$/i;

/**
 * Parse a request body strictly, or return `null` when it is malformed.
 *
 * Only a JSON request carrying a plain object with exactly the named keys, every value a bounded string, is
 * accepted. Unknown keys are refused rather than ignored, so a client cannot believe a field was honoured when it
 * was dropped. No value is coerced, and nothing submitted appears in any error.
 *
 * `newPassword` is bounded by the accepted policy and the 4 KiB body limit, not here: rejecting it at the
 * transport would change the policy's own error taxonomy.
 */
export function parseAuthBody(
  kind: AuthBodyKind,
  contentType: unknown,
  body: unknown,
): Record<string, string> | null {
  if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType)) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const required = REQUIRED_KEYS[kind];
  const keys = Object.keys(body);
  if (keys.length !== required.length || !required.every((key) => keys.includes(key))) return null;

  const record = body as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of required) {
    const value = record[key];
    if (typeof value !== 'string') return null;
    const limit =
      key === 'newPassword' ? 0 : key === 'token' ? MAX_RECOVERY_TOKEN_LENGTH : MAX_EMAIL_LENGTH;
    if (limit > 0 && value.length > limit) return null;
    result[key] = value;
  }
  return result;
}
