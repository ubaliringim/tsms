export const PASSWORD_POLICY = Object.freeze({ minCodePoints: 15, maxCodePoints: 128 });

export type PasswordPolicyResult =
  | { valid: true }
  | { valid: false; reason: 'invalid_type' | 'invalid_unicode' | 'too_short' | 'too_long' };

/** Count Unicode code points, not UTF-16 units or graphemes. Never transform input. */
export function validatePassword(candidate: unknown): PasswordPolicyResult {
  if (typeof candidate !== 'string') return { valid: false, reason: 'invalid_type' };
  // Bound work before scanning; a Unicode scalar uses at most two UTF-16 units.
  if (candidate.length > PASSWORD_POLICY.maxCodePoints * 2)
    return { valid: false, reason: 'too_long' };
  // Lone surrogates would be silently replaced by UTF-8 encoding; reject instead.
  if (/[\uD800-\uDFFF]/u.test(candidate)) return { valid: false, reason: 'invalid_unicode' };
  const length = [...candidate].length;
  if (length < PASSWORD_POLICY.minCodePoints) return { valid: false, reason: 'too_short' };
  if (length > PASSWORD_POLICY.maxCodePoints) return { valid: false, reason: 'too_long' };
  return { valid: true };
}
