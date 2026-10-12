import { resolveApiOrigin, type ApiOriginEnvironment } from './api-origin';

/**
 * Same-origin authentication proxy - Stage 2.8.
 *
 * The browser only ever talks to the web origin. These handlers relay exactly three API routes and
 * nothing else, so the session cookie is set by, and returned to, the web origin and the API needs no
 * CORS configuration.
 *
 * This is a relay, not a second session system. It holds no state, mints no token, reads no cookie value,
 * and decides nothing about authentication: the API's Origin allowlist, rate limits, generic failures and
 * revocation all still apply, because the API still receives the browser's own `Origin` and cookie.
 *
 * What crosses the proxy is an allowlist in each direction, not a blacklist:
 *
 *   browser -> API   content-type, accept, origin (verbatim), cookie (session cookie only; never on login)
 *   API -> browser   status, content-type, retry-after, session Set-Cookie, body
 *
 * `Host`, `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Referer`, `Authorization`, `X-Request-Id`, and every
 * other header are dropped, so no client-supplied value can influence the API's origin, client-identity
 * or correlation decisions through this hop. The proxy never writes `X-Forwarded-For`; the API ignores
 * it regardless, which is exactly why a shared proxy collapses clients onto one source address
 * (see docs/security/WEB_AUTHENTICATION.md).
 */

export type AuthRoute = 'login' | 'me' | 'logout';

const ROUTES: Readonly<Record<AuthRoute, { method: 'GET' | 'POST'; path: string }>> = {
  login: { method: 'POST', path: '/auth/login' },
  me: { method: 'GET', path: '/auth/me' },
  logout: { method: 'POST', path: '/auth/logout' },
};

/** The API's own request limit is 4 KiB; refusing more here keeps the relay from buffering a larger one. */
export const MAX_REQUEST_BYTES = 4096;
/**
 * Largest body accepted from the API, per route. A profile is an id, an address of at most 320 characters
 * and a display name; logout answers 204, so only an error body can appear there. Anything larger is not an
 * answer from this API.
 */
export const MAX_RESPONSE_BYTES: Readonly<Record<AuthRoute, number>> = {
  login: 4096,
  me: 4096,
  logout: 1024,
};
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** The two names the API can issue (`auth-cookie.ts`): production and development. */
const SESSION_COOKIE_NAMES: readonly string[] = ['__Host-tsms_session', 'tsms_session'];

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export interface ProxyDependencies {
  readonly environment: ApiOriginEnvironment;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function unavailable(status = 503): Response {
  // Fixed body. It never carries the upstream address, error text or any configuration value.
  return respond(status, JSON.stringify({ statusCode: status, error: 'service_unavailable' }));
}

function respond(status: number, body: string | null, headers: Headers = new Headers()): Response {
  // Every authentication response is uncacheable, including a failure that never reached the API.
  headers.set('cache-control', 'no-store');
  headers.set('vary', 'Origin');
  headers.set('x-content-type-options', 'nosniff');
  if (body !== null && !headers.has('content-type')) {
    headers.set('content-type', JSON_HEADERS['content-type']);
  }
  return new Response(status === 204 ? null : body, { status, headers });
}

/**
 * Keep only the session cookie from a browser `Cookie` header.
 *
 * Other cookies are never forwarded, so an unrelated cookie on the same origin cannot reach the API. A
 * repeated session cookie is forwarded as repeated: the API deliberately treats a duplicate as
 * unauthenticated, and collapsing it here would defeat that.
 */
export function sessionCookieOnly(header: string | null): string | null {
  if (header === null || header === '') return null;
  const kept: string[] = [];
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (SESSION_COOKIE_NAMES.includes(pair.slice(0, separator).trim())) kept.push(pair.trim());
  }
  return kept.length === 0 ? null : kept.join('; ');
}

/** Keep only a `Set-Cookie` that names the session cookie. */
function isSessionSetCookie(value: string): boolean {
  const name = value.slice(0, Math.max(0, value.indexOf('='))).trim();
  return SESSION_COOKIE_NAMES.includes(name);
}

/**
 * Whether a session `Set-Cookie` satisfies the accepted Stage 2.4 cookie contract.
 *
 * The proxy does not define or change that contract; it refuses to carry a cookie that departs from it. The
 * contract is `HttpOnly; SameSite=Lax; Path=/; Max-Age=<n>`, no `Domain`, and `Secure` whenever the name has
 * the `__Host-` prefix (which a browser would otherwise refuse anyway). Any other attribute - `Domain`,
 * `Partitioned`, an unknown one - is a departure. The proxy treats that as an unusable answer, so the web origin
 * never stores a session cookie weaker than the one the API's own tests assert.
 */
export function conformsToSessionCookieContract(value: string): boolean {
  const [pair = '', ...attributes] = value.split(';');
  const at = pair.indexOf('=');
  const name = pair.slice(0, at).trim();
  if (!SESSION_COOKIE_NAMES.includes(name)) return false;
  // 43 base64url characters when issued, empty when clearing.
  if (!/^[A-Za-z0-9_-]{0,64}$/.test(pair.slice(at + 1).trim())) return false;

  const seen = new Set<string>();
  let maxAge = false;
  for (const raw of attributes) {
    const attribute = raw.trim();
    const [key = '', ...rest] = attribute.split('=');
    const lower = key.trim().toLowerCase();
    const setting = rest.join('=').trim();
    if (seen.has(lower)) return false;
    seen.add(lower);
    switch (lower) {
      case 'httponly':
      case 'secure':
        if (setting !== '') return false;
        break;
      case 'samesite':
        if (setting.toLowerCase() !== 'lax') return false;
        break;
      case 'path':
        if (setting !== '/') return false;
        break;
      case 'max-age':
        if (!/^\d{1,10}$/.test(setting)) return false;
        maxAge = true;
        break;
      case 'expires':
        // Only the clearing cookie carries one, and only in the past.
        if (pair.slice(at + 1).trim() !== '' || Number.isNaN(Date.parse(setting))) return false;
        if (Date.parse(setting) > Date.now()) return false;
        break;
      default:
        return false;
    }
  }
  if (!maxAge || !seen.has('httponly') || !seen.has('samesite') || !seen.has('path')) return false;
  return !name.startsWith('__Host-') || seen.has('secure');
}

type BoundedBody =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid' };

/**
 * Read a body while counting bytes, never holding more than `limit` of them.
 *
 * The limit is enforced on the bytes actually received, not on `Content-Length`: a missing, chunked, or
 * dishonest length cannot buy extra buffering. A declared length over the limit is refused before any read.
 * Past the limit the stream is cancelled rather than drained. A stream error or malformed UTF-8 yields
 * `invalid`; nothing here throws, and no body content reaches an error value.
 */
export async function readBoundedBody(
  source: Request | Response,
  limit: number,
): Promise<BoundedBody> {
  const declared = source.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return { kind: 'invalid' };
    if (Number(declared) > limit) {
      await source.body?.cancel().catch(() => undefined);
      return { kind: 'too-large' };
    }
  }
  if (source.body === null) return { kind: 'ok', text: '' };

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: 'invalid' };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Relay one request to the API and translate the answer back through the response allowlist. */
export async function relayAuthRequest(
  route: AuthRoute,
  request: Request,
  dependencies: ProxyDependencies,
): Promise<Response> {
  const target = ROUTES[route];
  if (request.method !== target.method) return respond(405, null);

  const apiOrigin = resolveApiOrigin(dependencies.environment);
  if (apiOrigin === null) return unavailable();

  const headers = new Headers();
  const origin = request.headers.get('origin');
  // Verbatim, never synthesised: the API's allowlist decides, and a missing Origin is its refusal to make.
  if (origin !== null) headers.set('origin', origin);
  const contentType = request.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);
  headers.set('accept', 'application/json');
  // Login creates a session from credentials and never needs an existing one. Forwarding a cookie there would
  // only hand the API a token it has no use for, so it is withheld.
  const cookie = route === 'login' ? null : sessionCookieOnly(request.headers.get('cookie'));
  if (cookie !== null) headers.set('cookie', cookie);

  let body: string | undefined;
  if (target.method === 'POST') {
    const read = await readBoundedBody(request, MAX_REQUEST_BYTES);
    if (read.kind === 'too-large') {
      return respond(413, JSON.stringify({ statusCode: 413, error: 'request_too_large' }));
    }
    if (read.kind === 'invalid') {
      return respond(400, JSON.stringify({ statusCode: 400, error: 'invalid_request' }));
    }
    if (read.text !== '') body = read.text;
  }

  let upstream: Response;
  try {
    upstream = await (dependencies.fetch ?? fetch)(`${apiOrigin}${target.path}`, {
      method: target.method,
      headers,
      ...(body === undefined ? {} : { body }),
      // A redirect from the API is never followed: it would re-send the cookie to another place.
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }

  // The API never redirects. A 3xx, or an informational/odd status, is not an answer to relay.
  if (upstream.status < 200 || (upstream.status >= 300 && upstream.status < 400)) {
    return unavailable();
  }

  const responseHeaders = new Headers();
  const upstreamType = upstream.headers.get('content-type');
  if (upstreamType !== null && /^application\/json\b/i.test(upstreamType)) {
    responseHeaders.set('content-type', upstreamType);
  }
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter)) {
    responseHeaders.set('retry-after', retryAfter);
  }
  for (const value of upstream.headers.getSetCookie()) {
    if (!isSessionSetCookie(value)) continue;
    // A session cookie outside the accepted contract is refused outright rather than stored.
    if (!conformsToSessionCookieContract(value)) return unavailable();
    responseHeaders.append('set-cookie', value);
  }

  if (upstream.status === 204) {
    await upstream.body?.cancel().catch(() => undefined);
    return respond(204, null, responseHeaders);
  }
  const read = await readBoundedBody(upstream, MAX_RESPONSE_BYTES[route]);
  if (read.kind !== 'ok') return unavailable();
  return respond(upstream.status, read.text, responseHeaders);
}
