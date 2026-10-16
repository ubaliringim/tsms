/**
 * The outcome of consuming one atomic Redis meter - Stage 2.9.
 *
 * Kept in its own module because the Argon2id admission service (global workload budget) and the authentication
 * service (per-account success budget) both report it, and neither may import the other.
 *
 * - `charged`: the token was taken; proceed.
 * - `limited`: enforcement worked and declined. `retryAfterSeconds` is already clamped to the bounded whole-second
 *   range the `Retry-After` header uses.
 * - `unavailable`: enforcement could not be confirmed. Callers fail closed.
 */
export type MeterOutcome =
  | { readonly kind: 'charged' }
  | { readonly kind: 'limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'unavailable' };
