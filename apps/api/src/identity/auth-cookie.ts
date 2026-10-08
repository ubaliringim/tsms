/**
 * Browser session cookie policy - Stage 2.4.
 *
 * The transport attributes are *derived* from the already-validated `NODE_ENV`. There is
 * deliberately no separate toggle, and no configuration that can turn `Secure` off in
 * production: an operator cannot weaken the production cookie without changing code.
 *
 * The `__Host-` prefix is a browser-enforced contract that requires `Secure`, `Path=/` and the
 * absence of `Domain`. It is therefore used only where those hold - in production. Local
 * development serves plain HTTP on loopback, where a `Secure` cookie would never be stored, so
 * that is the single documented case where the name and `Secure` differ.
 */

export const SESSION_COOKIE = Object.freeze({
  productionName: '__Host-tsms_session',
  developmentName: 'tsms_session',
  path: '/',
  sameSite: 'Lax',
});

/** DI token carrying the resolved cookie policy for this process. */
export const SESSION_COOKIE_POLICY = Symbol('SESSION_COOKIE_POLICY');

export interface SessionCookiePolicy {
  /** Exact cookie name to set, read, and clear. */
  readonly name: string;
  readonly secure: boolean;
  readonly path: string;
  readonly sameSite: 'Lax';
}

export function sessionCookiePolicy(environment: 'development' | 'test' | 'production') {
  const production = environment === 'production';
  return Object.freeze({
    name: production ? SESSION_COOKIE.productionName : SESSION_COOKIE.developmentName,
    secure: production,
    path: SESSION_COOKIE.path,
    sameSite: SESSION_COOKIE.sameSite,
  }) satisfies SessionCookiePolicy;
}

/**
 * Serialize the session cookie.
 *
 * The value is the accepted Stage 2.3 token: 43 unpadded base64url characters, which contain no
 * character that requires cookie escaping, so it is emitted verbatim.
 *
 * `maxAgeSeconds` is bounded by the session's own absolute expiry, so the browser cannot hold the
 * cookie longer than the server will accept the token.
 */
export function serializeSessionCookie(
  policy: SessionCookiePolicy,
  value: string,
  maxAgeSeconds: number,
): string {
  const bounded = Math.max(0, Math.floor(maxAgeSeconds));
  return [
    `${policy.name}=${value}`,
    `Max-Age=${bounded}`,
    `Path=${policy.path}`,
    `SameSite=${policy.sameSite}`,
    'HttpOnly',
    ...(policy.secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Serialize the cookie that removes the session cookie from the browser.
 *
 * Attributes must match the setting attributes exactly, or the browser keeps the original. An
 * empty value plus `Max-Age=0` plus a past expiry is belt and braces: some clients honour only one
 * of them.
 */
export function clearSessionCookie(policy: SessionCookiePolicy): string {
  return serializeSessionCookie(policy, '', 0).replace(
    'Max-Age=0',
    'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  );
}

/**
 * Read the session token from a raw `Cookie` header.
 *
 * Returns `null` when the cookie is absent, empty, malformed, or **duplicated**.
 *
 * A duplicate is treated as unauthenticated rather than resolved by first or last occurrence. A
 * repeated cookie name is what a cookie-tossing attack from a subdomain looks like, and silently
 * picking one occurrence would let an attacker-planted cookie win over the real one. Rejecting is
 * the only choice that cannot be gamed by ordering.
 *
 * Only the configured name is considered; unrelated cookies are ignored. Values are not
 * unescaped: the token alphabet is base64url, so a percent- or quoted-string form is not a token
 * this stage issues and is rejected instead of being interpreted.
 */
export function readSessionCookie(header: unknown, policy: SessionCookiePolicy): string | null {
  if (typeof header !== 'string' || header === '') return null;
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== policy.name) continue;
    values.push(pair.slice(separator + 1).trim());
  }
  if (values.length !== 1) return null;
  const value = values[0]!;
  return value === '' ? null : value;
}

/** Seconds of cookie life left at `now` until `expiresAt`, never negative. */
export function cookieMaxAgeSeconds(expiresAt: Date, now: Date): number {
  return Math.max(0, (expiresAt.getTime() - now.getTime()) / 1000);
}
