import { createHash, randomBytes } from 'node:crypto';

/**
 * Recovery token format - Stage 2.5.
 *
 * Structurally identical to the accepted Stage 2.3 session token: 32 random bytes, canonical
 * unpadded base64url, SHA-256 digest persisted. The two token types are deliberately not
 * interchangeable - a session token is never accepted as a recovery token and vice versa - but they
 * share one implementation of the *format* rather than duplicating the CSPRNG and digest logic.
 *
 * Lifetime differs and is asserted separately: a session lives for seven days, a recovery token for
 * thirty minutes.
 */

export const RECOVERY_POLICY = Object.freeze({
  tokenBytes: 32,
  lifetimeMs: 30 * 60 * 1000,
});

/** DI token for the recovery clock, so expiry is deterministic under test. */
export const RECOVERY_CLOCK = Symbol('RECOVERY_CLOCK');

/**
 * Generate a recovery token.
 *
 * Only this function returns a raw recovery token. Nothing retrieves one afterwards, so a lost
 * token is unrecoverable by design.
 */
export function generateRecoveryToken(): string {
  return randomBytes(RECOVERY_POLICY.tokenBytes).toString('base64url');
}

/**
 * Exact canonical unpadded base64url of the expected length.
 *
 * Rejects trimming, padding, and non-canonical trailing bits rather than repairing them: a recovery
 * secret must be compared byte for byte or not at all.
 */
export function isRecoveryToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 43 &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

/** SHA-256 over the exact UTF-8 token string, encoded as lowercase hexadecimal. */
export function hashRecoveryToken(value: unknown): string | null {
  if (!isRecoveryToken(value)) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Absolute expiry for a token issued at `issuedAt`. Never extended by any later operation. */
export function recoveryExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + RECOVERY_POLICY.lifetimeMs);
}

/**
 * Build the reset URL delivered to the account owner.
 *
 * The base comes from validated configuration, never from a request header. The token is placed in
 * the fragment rather than the query string so it does not reach a server access log, a `Referer`
 * header, or any intermediary that records URLs.
 */
export function buildRecoveryUrl(base: string, token: string): string {
  const parsed = new URL(base);
  parsed.hash = `token=${token}`;
  return parsed.toString();
}
