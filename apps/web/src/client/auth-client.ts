/**
 * Browser-side client for the same-origin authentication proxy - Stage 2.8.
 *
 * It keeps no credential and no token: the session lives in an `HttpOnly` cookie the browser attaches
 * itself, which JavaScript cannot read. Nothing is written to `localStorage`, `sessionStorage`, a URL, or
 * a log. The only thing returned from a request is the public profile.
 *
 * Every outcome is a closed union so a caller must handle each case, and in particular must tell a
 * confirmed "not signed in" apart from "could not find out": a network failure is never evidence that the
 * session ended.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export type RestoreOutcome =
  | { readonly kind: 'authenticated'; readonly user: SessionUser }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

export type LoginOutcome =
  | { readonly kind: 'success'; readonly user: SessionUser }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'invalid-input' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable' };

export type LogoutOutcome = { readonly kind: 'confirmed' } | { readonly kind: 'unconfirmed' };

export interface AuthClient {
  restore(signal?: AbortSignal): Promise<RestoreOutcome>;
  login(email: string, password: string): Promise<LoginOutcome>;
  logout(): Promise<LogoutOutcome>;
}

const ENDPOINTS = {
  login: '/api/auth/login',
  me: '/api/auth/me',
  logout: '/api/auth/logout',
} as const;

function parseUser(body: unknown): SessionUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const user = (body as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const { id, email, displayName } = user as Record<string, unknown>;
  if (typeof id !== 'string' || typeof email !== 'string' || typeof displayName !== 'string') {
    return null;
  }
  return { id, email, displayName };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function retryAfterSeconds(response: Response): number | null {
  const value = Number(response.headers.get('retry-after'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function createAuthClient(request: typeof fetch = (...args) => fetch(...args)): AuthClient {
  // `same-origin` is the default for fetch but is stated so a future refactor cannot silently widen it,
  // and `no-store` keeps an intermediary or the HTTP cache from serving an old identity.
  const base = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } as const;

  return {
    async restore(signal) {
      let response: Response;
      try {
        response = await request(ENDPOINTS.me, {
          ...base,
          method: 'GET',
          headers: { accept: 'application/json' },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { kind: 'unavailable' };
      }
      // 401 is the API's single answer for a missing, expired, revoked, or disabled session.
      if (response.status === 401) return { kind: 'unauthenticated' };
      if (response.status === 200) {
        const user = parseUser(await readJson(response));
        return user === null ? { kind: 'unavailable' } : { kind: 'authenticated', user };
      }
      // 429, 5xx, and anything else: the session state is unknown, not ended.
      return { kind: 'unavailable' };
    },

    async login(email, password) {
      let response: Response;
      try {
        response = await request(ENDPOINTS.login, {
          ...base,
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch {
        return { kind: 'unavailable' };
      }
      if (response.status === 200) {
        const user = parseUser(await readJson(response));
        return user === null ? { kind: 'unavailable' } : { kind: 'success', user };
      }
      if (response.status === 401) return { kind: 'rejected' };
      if (response.status === 400 || response.status === 413) return { kind: 'invalid-input' };
      if (response.status === 429) {
        return { kind: 'rate-limited', retryAfterSeconds: retryAfterSeconds(response) };
      }
      return { kind: 'unavailable' };
    },

    async logout() {
      let response: Response;
      try {
        response = await request(ENDPOINTS.logout, { ...base, method: 'POST' });
      } catch {
        return { kind: 'unconfirmed' };
      }
      // Only the API's 204 is a confirmation. 403 (untrusted origin), 429, 5xx, and a proxy failure all
      // leave the session in an unknown state, so none of them may be reported as signed out.
      return response.status === 204 ? { kind: 'confirmed' } : { kind: 'unconfirmed' };
    },
  };
}
