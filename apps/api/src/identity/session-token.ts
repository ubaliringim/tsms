import { createHash, randomBytes } from 'node:crypto';
import { SessionError } from './session-error.js';

export const SESSION_POLICY = Object.freeze({
  tokenBytes: 32,
  lifetimeMs: 7 * 24 * 60 * 60 * 1000,
});

export function generateSessionToken(): string {
  try {
    return randomBytes(SESSION_POLICY.tokenBytes).toString('base64url');
  } catch {
    throw new SessionError('SERVICE_FAILURE');
  }
}

/** Exact canonical unpadded base64url; never normalize bearer secrets. */
export function isSessionToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 43 &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

/** SHA-256 over the exact UTF-8 token string, encoded as lowercase hexadecimal. */
export function hashSessionToken(value: unknown): string {
  if (!isSessionToken(value)) throw new SessionError('INVALID_TOKEN');
  try {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  } catch {
    throw new SessionError('SERVICE_FAILURE');
  }
}
