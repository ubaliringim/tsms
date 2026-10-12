import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  relayAuthRequest,
  sessionCookieOnly,
  type AuthRoute,
} from '../src/server/auth-proxy';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
type Reply = (seen: Seen) => {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string;
  delayMs?: number;
};

let server: Server;
let origin: string;
let seen: Seen[];
let reply: Reply;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const record: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(record);
      const answer = reply(record);
      setTimeout(() => {
        response.writeHead(answer.status, answer.headers ?? {});
        response.end(answer.body ?? '');
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
});

const WEB_ORIGIN = 'http://127.0.0.1:3000';
const environment = () => ({ NODE_ENV: 'test', TSMS_API_ORIGIN: origin });

function relay(route: AuthRoute, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const method = init.method ?? (route === 'me' ? 'GET' : 'POST');
  const request = new Request(`${WEB_ORIGIN}/api/auth/${route}`, { ...init, method });
  return relayAuthRequest(route, request, { environment: environment() });
}

describe('request relay', () => {
  it('forwards only the allowlisted headers and the exact API path', async () => {
    await relay('login', {
      headers: {
        'content-type': 'application/json',
        origin: WEB_ORIGIN,
        cookie: 'analytics=1; tsms_session=abc123; theme=dark',
        host: 'evil.example',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        forwarded: 'for=203.0.113.9',
        'x-real-ip': '203.0.113.9',
        referer: 'https://evil.example/page',
        authorization: 'Bearer stolen',
        'x-request-id': 'attacker-chosen',
      },
      body: JSON.stringify({ email: 'a@example.test', password: 'p' }),
    });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call).toMatchObject({ method: 'POST', url: '/auth/login' });
    expect(call?.body).toBe(JSON.stringify({ email: 'a@example.test', password: 'p' }));
    expect(call?.headers['origin']).toBe(WEB_ORIGIN);
    expect(call?.headers['content-type']).toBe('application/json');
    // Login never needs an existing session, so none is forwarded.
    expect(call?.headers['cookie']).toBeUndefined();
    for (const name of [
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'forwarded',
      'x-real-ip',
      'referer',
      'authorization',
      'x-request-id',
    ]) {
      expect(call?.headers[name], name).toBeUndefined();
    }
    // `Host` is the upstream's own, never the browser-supplied one.
    expect(call?.headers['host']).toBe(new URL(origin).host);
  });

  it('never invents an Origin: a request without one reaches the API without one', async () => {
    await relay('logout');
    expect(seen[0]?.headers['origin']).toBeUndefined();
  });

  it('forwards a hostile Origin verbatim so the API, not the proxy, refuses it', async () => {
    reply = () => ({ status: 403, body: '{"statusCode":403,"error":"forbidden_origin"}' });
    const response = await relay('logout', { headers: { origin: 'https://evil.example' } });
    expect(seen[0]?.headers['origin']).toBe('https://evil.example');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
  });

  it('forwards a repeated session cookie as repeated, so the API can reject the duplicate', () => {
    expect(sessionCookieOnly('tsms_session=a; x=1; tsms_session=b')).toBe(
      'tsms_session=a; tsms_session=b',
    );
  });

  it('forwards the production cookie name and drops lookalikes', () => {
    expect(sessionCookieOnly('__Host-tsms_session=tok')).toBe('__Host-tsms_session=tok');
    expect(sessionCookieOnly('tsms_session_x=a; xtsms_session=b; =c; noequals')).toBeNull();
    expect(sessionCookieOnly(null)).toBeNull();
    expect(sessionCookieOnly('')).toBeNull();
  });

  it('sends no cookie header when the browser sent no session cookie', async () => {
    await relay('me', { headers: { cookie: 'analytics=1' } });
    expect(seen[0]?.headers['cookie']).toBeUndefined();
  });

  it('refuses an oversized body without calling the API', async () => {
    const response = await relay('login', {
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: 'x'.repeat(MAX_REQUEST_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('answers a wrong method itself, without calling the API', async () => {
    const response = await relay('login', { method: 'GET' });
    expect(response.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});

describe('response relay', () => {
  it('relays the status and body, adds no-store, and passes the session cookie through unchanged', async () => {
    const cookie = 'tsms_session=tok; Max-Age=600; Path=/; SameSite=Lax; HttpOnly';
    reply = () => ({
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [cookie, 'tracking=1; Path=/', '__Host-other=2; Secure; Path=/'],
        'x-powered-by': 'Express',
        server: 'upstream',
        'access-control-allow-origin': '*',
      },
      body: '{"user":{"id":"1","email":"a@example.test","displayName":"A"}}',
    });
    const response = await relay('login', { headers: { origin: WEB_ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([cookie]);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Origin');
    for (const name of ['x-powered-by', 'server', 'access-control-allow-origin']) {
      expect(response.headers.get(name), name).toBeNull();
    }
    expect(await response.json()).toEqual({
      user: { id: '1', email: 'a@example.test', displayName: 'A' },
    });
  });

  it('relays logout 204 with the clearing cookie and an empty body', async () => {
    const clear =
      'tsms_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; HttpOnly';
    reply = () => ({ status: 204, headers: { 'set-cookie': clear } });
    const response = await relay('logout', { headers: { origin: WEB_ORIGIN } });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([clear]);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('relays a numeric Retry-After and drops a malformed one', async () => {
    reply = () => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: '{"error":"rate_limited"}',
    });
    expect((await relay('login')).headers.get('retry-after')).toBe('30');
    reply = () => ({ status: 429, headers: { 'retry-after': 'soon' }, body: '{}' });
    expect((await relay('login')).headers.get('retry-after')).toBeNull();
  });

  it('marks failures uncacheable even when the API sent a cacheable header', async () => {
    reply = () => ({
      status: 401,
      headers: { 'cache-control': 'public, max-age=3600', 'content-type': 'application/json' },
      body: '{"statusCode":401,"error":"authentication_failed"}',
    });
    const response = await relay('me');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('upstream failure', () => {
  const GENERIC = { statusCode: 503, error: 'service_unavailable' };

  it('answers a redirect with a generic 503 and never follows it', async () => {
    reply = () => ({ status: 302, headers: { location: 'https://evil.example/' } });
    const response = await relay('me');
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('answers an unreachable API with a generic 503 that does not name it', async () => {
    const response = await relayAuthRequest('me', new Request(`${WEB_ORIGIN}/api/auth/me`), {
      environment: { NODE_ENV: 'test', TSMS_API_ORIGIN: 'http://127.0.0.1:1' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(GENERIC);
  });

  it('times out a stalled API', async () => {
    reply = () => ({ status: 200, body: '{}', delayMs: 400 });
    const response = await relayAuthRequest('me', new Request(`${WEB_ORIGIN}/api/auth/me`), {
      environment: environment(),
      timeoutMs: 50,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(GENERIC);
  });

  it('refuses an implausibly large API body', async () => {
    reply = () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20_000),
    });
    const response = await relay('me');
    expect(response.status).toBe(503);
  });

  it('fails closed on unusable configuration without echoing it', async () => {
    const secretish = 'https://user:hunter2@api.example.test/path';
    const response = await relayAuthRequest('me', new Request(`${WEB_ORIGIN}/api/auth/me`), {
      environment: { NODE_ENV: 'production', TSMS_API_ORIGIN: secretish },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/hunter2|api\.example/);
    const missing = await relayAuthRequest('me', new Request(`${WEB_ORIGIN}/api/auth/me`), {
      environment: { NODE_ENV: 'production' },
    });
    expect(missing.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('every proxy-generated failure is uncacheable', async () => {
    const response = await relayAuthRequest('me', new Request(`${WEB_ORIGIN}/api/auth/me`), {
      environment: { NODE_ENV: 'production' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
