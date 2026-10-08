import type { ExecutionContext, CanActivate } from '@nestjs/common';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';

/** DI token carrying the startup-validated, normalised origin allowlist. */
export const TRUSTED_ORIGINS = Symbol('TRUSTED_ORIGINS');

/** Fixed rejection body. It does not echo the submitted Origin. */
export function forbiddenOrigin(): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, error: 'forbidden_origin' });
}

/**
 * Exact-match check of a request `Origin` against the configured allowlist.
 *
 * Exported separately from the guard so the policy can be unit-tested without building an
 * execution context.
 */
export function isTrustedOrigin(
  header: unknown,
  trustedOrigins: readonly string[],
): header is string {
  if (typeof header !== 'string' || header === '') return false;
  return trustedOrigins.includes(header);
}

/**
 * CSRF admission control for the two state-changing authentication routes.
 *
 * Cookies are attached automatically by the browser, so a cross-site request reaches this server
 * carrying valid credentials without the victim's intent. The state-changing routes therefore
 * require an `Origin` that appears in the startup-validated allowlist.
 *
 * The trusted value never comes from `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, or
 * `Referer`. All of those are supplied by the client and are only trustworthy behind a proxy that
 * is explicitly configured to strip and rewrite them; no such proxy is deployed or validated in
 * this stage, so treating them as trusted would hand the allowlist to an attacker who can send
 * arbitrary headers.
 *
 * A **missing** Origin is rejected rather than allowed. Browsers attach `Origin` to every POST
 * regardless of same- or cross-site, so requiring it costs real clients nothing while closing the
 * hole a "reject only when present and wrong" rule leaves open. Non-browser clients must send an
 * explicit Origin; that is documented behaviour, not an accident.
 *
 * Matching is exact string equality against origins normalised at startup, so scheme, host, and
 * port must all agree. There is no wildcard, no suffix or subdomain match, and no same-origin
 * inference from the request.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  constructor(@Inject(TRUSTED_ORIGINS) private readonly trustedOrigins: readonly string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (!isTrustedOrigin(request.headers['origin'], this.trustedOrigins)) {
      throw forbiddenOrigin();
    }
    return true;
  }
}
