import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conformsToSessionCookieContract,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  readBoundedBody,
  relayAuthRequest,
  type AuthRoute,
} from '../src/server/auth-proxy';

/**
 * Stage 2.8 corrections: streaming request limits, upstream response caps, cookie forwarding per route, and the
 * session-cookie contract. Kept apart from `auth-proxy.test.ts` so each file reads as one concern.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
type Reply = () => {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  chunked?: boolean;
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
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const answer = reply();
      response.writeHead(answer.status, answer.headers ?? {});
      const payload = Buffer.from(answer.body ?? '');
      if (answer.chunked) {
        // Writing before `end` with no declared length makes Node send chunked.
        for (let at = 0; at < payload.length; at += 700) {
          response.write(payload.subarray(at, at + 700));
        }
        response.end();
      } else {
        response.end(payload);
      }
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

function relay(route: AuthRoute, init: RequestInit & { duplex?: 'half' } = {}) {
  const method = init.method ?? (route === 'me' ? 'GET' : 'POST');
  return relayAuthRequest(
    route,
    new Request(`${WEB_ORIGIN}/api/auth/${route}`, { ...init, method }),
    { environment: environment() },
  );
}

describe('cookie forwarding per route', () => {
  const cookies = 'analytics=1; tsms_session=tok123; theme=dark';

  it('forwards no cookie at all on login, even a valid session cookie', async () => {
    await relay('login', {
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie: cookies },
      body: '{}',
    });
    expect(seen[0]?.headers['cookie']).toBeUndefined();
  });

  it('forwards exactly the session cookie on /me', async () => {
    await relay('me', { headers: { cookie: cookies } });
    expect(seen[0]?.headers['cookie']).toBe('tsms_session=tok123');
  });

  it('forwards exactly the session cookie on logout', async () => {
    await relay('logout', { headers: { origin: WEB_ORIGIN, cookie: cookies } });
    expect(seen[0]?.headers['cookie']).toBe('tsms_session=tok123');
  });

  it('forwards the production-named cookie and never an unrelated one', async () => {
    await relay('me', { headers: { cookie: 'sid=1; __Host-tsms_session=prod; csrf=2' } });
    expect(seen[0]?.headers['cookie']).toBe('__Host-tsms_session=prod');
  });

  it('forwards a duplicated session cookie as duplicated, so the API refuses it', async () => {
    await relay('me', { headers: { cookie: 'tsms_session=a; tsms_session=b' } });
    expect(seen[0]?.headers['cookie']).toBe('tsms_session=a; tsms_session=b');
  });
});

describe('bounded request body', () => {
  const login = (init: RequestInit & { duplex?: 'half' }) =>
    relay('login', {
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      ...init,
    });

  /** A stream that records how much was pulled from it and whether it was cancelled. */
  function counting(chunkBytes: number, chunks: number) {
    const state = { pulled: 0, cancelled: false };
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) return controller.close();
        sent += 1;
        state.pulled += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it('refuses a chunked body over the limit, stops reading, and cancels the stream', async () => {
    const { stream, state } = counting(1024, 1000);
    const response = await login({ body: stream, duplex: 'half' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ statusCode: 413, error: 'request_too_large' });
    expect(seen).toHaveLength(0);
    expect(state.cancelled).toBe(true);
    // It stopped near the limit instead of draining a megabyte.
    expect(state.pulled).toBeLessThan(MAX_REQUEST_BYTES + 64 * 1024);
  });

  it('refuses an oversized body that declares no Content-Length', async () => {
    const response = await login({ body: 'a'.repeat(MAX_REQUEST_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('refuses a body whose Content-Length lies about its size', async () => {
    const { stream } = counting(1024, 20);
    const response = await login({
      body: stream,
      duplex: 'half',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'content-length': '10' },
    });
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('refuses a declared Content-Length over the limit without reading any of the body', async () => {
    const { stream, state } = counting(1024, 20);
    const response = await login({
      body: stream,
      duplex: 'half',
      headers: {
        'content-type': 'application/json',
        origin: WEB_ORIGIN,
        'content-length': String(MAX_REQUEST_BYTES + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(1024);
    expect(state.cancelled).toBe(true);
  });

  it('counts bytes, not characters: a multibyte body under the character limit is refused', async () => {
    const body = 'é'.repeat(MAX_REQUEST_BYTES / 2 + 1);
    expect(body.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect((await login({ body })).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('accepts a body of exactly the limit', async () => {
    const body = 'a'.repeat(MAX_REQUEST_BYTES);
    expect((await login({ body })).status).toBe(200);
    expect(seen[0]?.body).toBe(body);
  });

  it('answers malformed UTF-8 with a generic 400 and does not call the API', async () => {
    const response = await login({ body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'invalid_request' });
    expect(seen).toHaveLength(0);
  });

  it('answers a malformed Content-Length with a generic 400', async () => {
    const response = await login({
      body: '{}',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'content-length': 'abc' },
    });
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('survives a stream that errors mid-body without leaking its content', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"email":"a@example.test","pass'));
        controller.error(new Error('secret-body-fragment'));
      },
    });
    const response = await login({ body: stream, duplex: 'half' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret-body-fragment');
    expect(seen).toHaveLength(0);
  });

  it('never returns more than the limit it was given', async () => {
    expect(await readBoundedBody(new Response(new Uint8Array(500)), 100)).toEqual({
      kind: 'too-large',
    });
  });
});

describe('bounded upstream response', () => {
  const big = (bytes: number) => 'x'.repeat(bytes);
  const json = { 'content-type': 'application/json' };

  it.each([
    ['login', 'POST'],
    ['me', 'GET'],
  ] as const)('accepts a %s body at its cap and refuses one byte more', async (route, method) => {
    reply = () => ({ status: 200, headers: json, body: big(MAX_RESPONSE_BYTES[route]) });
    const ok = await relay(route, { method, headers: { origin: WEB_ORIGIN } });
    expect(ok.status).toBe(200);
    reply = () => ({ status: 200, headers: json, body: big(MAX_RESPONSE_BYTES[route] + 1) });
    expect((await relay(route, { method, headers: { origin: WEB_ORIGIN } })).status).toBe(503);
  });

  it('applies a smaller cap to logout', async () => {
    reply = () => ({ status: 400, headers: json, body: big(MAX_RESPONSE_BYTES.logout + 1) });
    expect((await relay('logout', { headers: { origin: WEB_ORIGIN } })).status).toBe(503);
  });

  it('refuses an oversized chunked response that declares no length', async () => {
    reply = () => ({ status: 200, headers: json, body: big(200_000), chunked: true });
    expect((await relay('me')).status).toBe(503);
  });

  it('answers malformed UTF-8 from the API with a generic 503', async () => {
    reply = () => ({ status: 200, headers: json, body: Buffer.from([0x7b, 0xff, 0x7d]) });
    const response = await relay('me');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ statusCode: 503, error: 'service_unavailable' });
  });
});

describe('session cookie contract', () => {
  const issued = (name: string, extra = '') =>
    `${name}=${'a'.repeat(43)}; Max-Age=600; Path=/; SameSite=Lax; HttpOnly${extra}`;
  const production = issued('__Host-tsms_session', '; Secure');

  it('accepts exactly the accepted production cookie', () => {
    expect(conformsToSessionCookieContract(production)).toBe(true);
    // __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/, and no Domain.
    expect(production).toMatch(/^__Host-tsms_session=/);
    for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
      expect(production).toContain(part);
    }
    expect(production).not.toMatch(/Domain=/i);
  });

  it('accepts the development cookie and the clearing cookie', () => {
    expect(conformsToSessionCookieContract(issued('tsms_session'))).toBe(true);
    expect(
      conformsToSessionCookieContract(
        'tsms_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; HttpOnly',
      ),
    ).toBe(true);
  });

  it.each([
    ['a Domain attribute', issued('tsms_session', '; Domain=example.test')],
    ['SameSite=None', issued('tsms_session').replace('SameSite=Lax', 'SameSite=None')],
    ['SameSite=Strict', issued('tsms_session').replace('SameSite=Lax', 'SameSite=Strict')],
    ['a missing HttpOnly', issued('tsms_session').replace('; HttpOnly', '')],
    ['a missing SameSite', issued('tsms_session').replace('; SameSite=Lax', '')],
    ['a narrower Path', issued('tsms_session').replace('Path=/', 'Path=/auth')],
    ['a missing Max-Age', issued('tsms_session').replace('Max-Age=600; ', '')],
    ['a Partitioned attribute', issued('tsms_session', '; Partitioned')],
    ['an unknown attribute', issued('tsms_session', '; Priority=High')],
    ['a repeated attribute', issued('tsms_session', '; Path=/')],
    ['a __Host- name without Secure', issued('__Host-tsms_session')],
    [
      'a future Expires on an issued cookie',
      issued('tsms_session', '; Expires=Fri, 01 Jan 2100 00:00:00 GMT'),
    ],
    ['an unsafe token value', 'tsms_session=a b; Max-Age=1; Path=/; SameSite=Lax; HttpOnly'],
  ])('rejects %s', (_label, value) => {
    expect(conformsToSessionCookieContract(value)).toBe(false);
  });

  it('refuses to relay a non-conforming session cookie and sets none', async () => {
    reply = () => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': issued('tsms_session', '; Domain=example.test'),
      },
      body: '{"user":{"id":"1","email":"a@example.test","displayName":"A"}}',
    });
    const response = await relay('login', { headers: { origin: WEB_ORIGIN } });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
