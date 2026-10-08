import * as argon2 from 'argon2';
import { validatePassword } from './password-policy.js';
import { PasswordCredentialError } from './password-error.js';

export const ARGON2_PARAMETERS = Object.freeze({
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 65_536, // KiB: 64 MiB per operation
  timeCost: 3,
  parallelism: 1,
  hashLength: 32, // bytes
});

/** Defensive envelope only; Argon2 performs decoding and cryptographic verification.
 * Bound corrupt stored costs before native allocation. Older costs remain verifiable.
 */
function inspectHash(encoded: unknown): { hashLength: number } {
  if (typeof encoded !== 'string' || encoded.length > 512)
    throw new PasswordCredentialError('VERIFICATION_FAILURE');
  const match =
    /^\$argon2id\$v=(16|19)\$m=(\d{1,6}),p=(\d{1,2}),t=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      encoded,
    );
  if (!match) throw new PasswordCredentialError('VERIFICATION_FAILURE');
  const memory = Number(match[2]),
    time = Number(match[4]),
    lanes = Number(match[3]);
  const salt = Buffer.from(match[5]!, 'base64'),
    digest = Buffer.from(match[6]!, 'base64');
  if (
    lanes < 1 ||
    lanes > 4 ||
    memory < 8 * lanes ||
    memory > 262_144 ||
    time < 1 ||
    time > 10 ||
    salt.length < 8 ||
    salt.length > 64 ||
    digest.length < 16 ||
    digest.length > 64 ||
    salt.toString('base64').replace(/=+$/, '') !== match[5] ||
    digest.toString('base64').replace(/=+$/, '') !== match[6]
  )
    throw new PasswordCredentialError('VERIFICATION_FAILURE');
  return { hashLength: digest.length };
}

export async function hashPassword(candidate: unknown): Promise<string> {
  if (!validatePassword(candidate).valid) throw new PasswordCredentialError('INVALID_PASSWORD');
  try {
    return await argon2.hash(candidate as string, ARGON2_PARAMETERS);
  } catch {
    throw new PasswordCredentialError('HASH_FAILURE');
  }
}

export function needsPasswordRehash(encoded: string): boolean {
  const info = inspectHash(encoded);
  try {
    return (
      argon2.needsRehash(encoded, ARGON2_PARAMETERS) ||
      info.hashLength !== ARGON2_PARAMETERS.hashLength
    );
  } catch {
    throw new PasswordCredentialError('VERIFICATION_FAILURE');
  }
}

export type PasswordVerification =
  { matches: false; needsRehash: false } | { matches: true; needsRehash: boolean };

export async function verifyPassword(
  candidate: unknown,
  encoded: string,
): Promise<PasswordVerification> {
  // Invalid candidates are ordinary rejection; storage/native failures are separate errors.
  if (!validatePassword(candidate).valid) return { matches: false, needsRehash: false };
  inspectHash(encoded);
  try {
    if (!(await argon2.verify(encoded, candidate as string)))
      return { matches: false, needsRehash: false };
    return { matches: true, needsRehash: needsPasswordRehash(encoded) };
  } catch {
    throw new PasswordCredentialError('VERIFICATION_FAILURE');
  }
}
