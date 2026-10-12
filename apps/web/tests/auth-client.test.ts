import { describe, expect, it } from 'vitest';
import { createAuthClient } from '../src/client/auth-client';

const USER = { id: 'u1', email: 'a@example.test', displayName: 'Synthetic' };

function client(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  calls: Array<{ url: string; init: RequestInit }> = [],
) {
  return createAuthClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  });
}
const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const down = () => {
  throw new TypeError('fetch failed');
};

describe('restore', () => {
  it('reports the user for a valid session, using same-origin credentials and no cache', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await client(() => json(200, { user: USER }), calls).restore();
    expect(outcome).toEqual({ kind: 'authenticated', user: USER });
    expect(calls[0]?.url).toBe('/api/auth/me');
    expect(calls[0]?.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });

  it('reports unauthenticated only for the API 401', async () => {
    const body = { statusCode: 401, error: 'authentication_failed' };
    expect(await client(() => json(401, body)).restore()).toEqual({ kind: 'unauthenticated' });
  });

  it.each([429, 500, 502, 503, 403, 404])(
    'treats HTTP %i as unknown, never as signed out',
    async (status) => {
      expect(await client(() => json(status, {})).restore()).toEqual({ kind: 'unavailable' });
    },
  );

  it('treats a network failure as unknown, never as signed out', async () => {
    expect(await client(down).restore()).toEqual({ kind: 'unavailable' });
  });

  it.each([{}, { user: null }, { user: { id: 1, email: 'a', displayName: 'b' } }, 'text'])(
    'treats a malformed success body %j as unknown',
    async (body) => {
      expect(await client(() => json(200, body)).restore()).toEqual({ kind: 'unavailable' });
    },
  );

  it('treats an unparseable success body as unknown', async () => {
    const outcome = await client(() => new Response('<html>', { status: 200 })).restore();
    expect(outcome).toEqual({ kind: 'unavailable' });
  });
});

describe('login', () => {
  it('posts JSON credentials to the proxy only, and returns the user', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await client(() => json(200, { user: USER }), calls).login(
      'a@example.test',
      'pw',
    );
    expect(outcome).toEqual({ kind: 'success', user: USER });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/auth/login');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ email: 'a@example.test', password: 'pw' }));
    // Credentials travel in the body, never the URL.
    expect(calls[0]?.url).not.toMatch(/pw|a@example/);
  });

  it('maps every non-success to a closed outcome without exposing the reason', async () => {
    const run = (status: number, headers: HeadersInit = {}) =>
      client(() => json(status, {}, headers)).login('a', 'b');
    expect(await run(401)).toEqual({ kind: 'rejected' });
    expect(await run(400)).toEqual({ kind: 'invalid-input' });
    expect(await run(413)).toEqual({ kind: 'invalid-input' });
    expect(await run(429, { 'retry-after': '30' })).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 30,
    });
    expect(await run(429)).toEqual({ kind: 'rate-limited', retryAfterSeconds: null });
    expect(await run(503)).toEqual({ kind: 'unavailable' });
    expect(await run(403)).toEqual({ kind: 'unavailable' });
    expect(await client(down).login('a', 'b')).toEqual({ kind: 'unavailable' });
  });

  it('does not report success for a 200 without a valid profile', async () => {
    expect(await client(() => json(200, {})).login('a', 'b')).toEqual({ kind: 'unavailable' });
  });
});

describe('logout', () => {
  it('confirms only on the API 204', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    expect(await client(() => new Response(null, { status: 204 }), calls).logout()).toEqual({
      kind: 'confirmed',
    });
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', init: { method: 'POST' } });
  });

  it.each([200, 401, 403, 429, 500, 503])('does not confirm on HTTP %i', async (status) => {
    expect(await client(() => json(status, {})).logout()).toEqual({ kind: 'unconfirmed' });
  });

  it('does not confirm on a network failure', async () => {
    expect(await client(down).logout()).toEqual({ kind: 'unconfirmed' });
  });
});
