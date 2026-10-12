/**
 * Stage 2.7 - server-generated request correlation.
 *
 * `AuthenticationEvent.requestId` and the security log both need a correlation id, and the API had none.
 * The rules are deliberately strict, because a correlation id is one of the few values in this system that
 * originates outside the database and therefore could carry caller influence:
 *
 * - The id is always generated here. Any inbound `X-Request-Id` is ignored rather than echoed, so a client
 *   cannot choose the value that ends up in an audit row. Honouring a client value would let an attacker
 *   correlate unrelated requests by reusing one, or plant chosen text in the audit trail.
 * - It is a random UUID with no derivation from the request, so it carries no address, header, or body
 *   content and nothing to correlate across users.
 * - It is echoed in the response header purely so a user can quote it in a support request. It is not a
 *   capability and authorises nothing.
 */

import { randomUUID } from 'node:crypto';

/**
 * Symbol-keyed so the value cannot collide with, or be overwritten by, a property on the request object.
 *
 * A string key would be reachable by anything holding the request - including future middleware - and an
 * overwritable correlation id is worse than none.
 */
const REQUEST_ID = Symbol('tsms.securityRequestId');

/** Header used to echo the generated id back to the caller. Reading it is never trusted. */
export const SECURITY_REQUEST_ID_HEADER = 'x-request-id';

interface RequestWithSecurityId {
  [REQUEST_ID]?: string;
}

/** The response surface the middleware writes to, without depending on an Express type import. */
interface MinimalResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Generate a correlation id for every request.
 *
 * Registered before the body-size guard so even a rejected oversized request carries an id that can be
 * found in the logs.
 */
export function securityRequestContext(
  request: RequestWithSecurityId,
  response: MinimalResponse,
  next: () => void,
): void {
  const requestId = randomUUID();
  request[REQUEST_ID] = requestId;
  try {
    response.setHeader(SECURITY_REQUEST_ID_HEADER, requestId);
  } catch {
    // Headers may already be sent on some error paths; correlation is still recorded internally.
  }
  next();
}

/**
 * Read the correlation id from a request, if the middleware ran.
 *
 * Returns `undefined` rather than generating one lazily, so an event written outside a request cycle is
 * visibly uncorrelated instead of silently sharing an id with something else.
 */
export function requestIdOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const value = (request as RequestWithSecurityId)[REQUEST_ID];
  return typeof value === 'string' ? value : undefined;
}
