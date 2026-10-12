/**
 * Where the web server sends authentication requests - Stage 2.8.
 *
 * `TSMS_API_ORIGIN` is read on the server only and is never exposed to the browser: there is no
 * `NEXT_PUBLIC_` variant, so a browser can never be pointed at the API directly.
 *
 * Development may omit it and gets the documented loopback API. Production may not: a missing value
 * is a configuration error rather than a silent fall back to a development address, and a non-loopback
 * upstream must use HTTPS so session cookies and credentials never cross a network in clear text.
 */

export const DEFAULT_DEVELOPMENT_API_ORIGIN = 'http://127.0.0.1:4000';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface ApiOriginEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly TSMS_API_ORIGIN?: string | undefined;
}

/**
 * Resolve the validated upstream origin, or `null` when configuration is unusable.
 *
 * The caller answers `null` with a generic `503` and never echoes the configured value.
 */
export function resolveApiOrigin(environment: ApiOriginEnvironment): string | null {
  const production = environment.NODE_ENV === 'production';
  const configured = environment.TSMS_API_ORIGIN?.trim() ?? '';
  if (configured === '') return production ? null : DEFAULT_DEVELOPMENT_API_ORIGIN;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  // An origin never has a trailing path, so `https://api.example.com/` is accepted only as that origin.
  if (configured.replace(/\/$/, '') !== url.origin) return null;
  if (production && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.origin;
}
