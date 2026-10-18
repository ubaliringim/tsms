import http from 'node:http';
import { URLSearchParams } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COOKIE,
  PASSWORD,
  SESSION_LIFETIME_MS,
  TRUSTED_ORIGIN,
  cookieHeader,
  createHarness,
  tokenFrom,
} from './support/stage210-harness.mjs';
import { SessionService } from '../dist/identity/session.service.js';
import { generateSessionToken, hashSessionToken } from '../dist/identity/session-token.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
} from '../dist/identity/password-recovery-token.js';

/**
 * Stage 2.10.1: session, logout, method-handling and password-encoding regression and characterization tests.
 *
 * How to read the test names:
 *
 *   INVARIANT         a security property the system is meant to hold. A failure is a defect.
 *   CHARACTERIZATION  what the system does TODAY. It pins current behaviour so that a change is a visible decision. It
 *                     is NOT a statement that the behaviour is safe or intended, and several of them describe known,
 *                     owner-accepted development-only risks. Each says which.
 *
 * No application behaviour is changed by this file.
 */

const h = createHarness({ secret: 'stage210_session_suite_rate_limit_key_0123456789ab' });

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.resetState());
afterEach(() => h.cleanup());

const sessionRow = (token) =>
  h.db.session.findUnique({ where: { tokenHash: hashSessionToken(token) } });

describe('SES-02 session fixation', () => {
  it('INVARIANT: login never adopts a session value presented in the cookie', async () => {
    const user = await h.account();
    const attacker = generateSessionToken(); // well-formed, chosen by "the attacker", unknown to the server
    expect(await sessionRow(attacker)).toBeNull();

    const response = await h.login(user.email, PASSWORD, { cookie: cookieHeader(attacker) });
    expect(response.status).toBe(200);
    const issued = tokenFrom(response);
    expect(issued).toBeDefined();
    expect(issued).not.toBe(attacker);

    // The presented value did not become a session, and it grants nothing.
    expect(await sessionRow(attacker)).toBeNull();
    expect((await h.me(attacker)).status).toBe(401);
    expect((await h.me(issued)).status).toBe(200);
  });

  it('INVARIANT: login ignores whatever cookie it is shown, however malformed or repeated', async () => {
    const user = await h.account();
    for (const cookie of [
      `${COOKIE}=not-a-token`,
      `${COOKIE}=`,
      `${COOKIE}=${generateSessionToken()}; ${COOKIE}=${generateSessionToken()}`,
      'unrelated=1',
    ]) {
      const response = await h.login(user.email, PASSWORD, { cookie });
      expect(response.status, cookie).toBe(200);
      expect(tokenFrom(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('INVARIANT: logging in while holding a valid session issues a different session', async () => {
    const user = await h.account();
    const first = tokenFrom(await h.login(user.email));
    const second = tokenFrom(await h.login(user.email, PASSWORD, { cookie: cookieHeader(first) }));
    expect(second).not.toBe(first);
    const [a, b] = [await sessionRow(first), await sessionRow(second)];
    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe(user.id);
    expect(b.userId).toBe(user.id);
  });

  it('CHARACTERIZATION: a second login does not revoke or rotate the session it was shown', async () => {
    // This is not session fixation (the attacker never chooses a value the server accepts). It does mean that signing
    // in again leaves earlier sessions of the same user live until they expire or are revoked one by one. There is no
    // "sign out everywhere"; the owner deferred that to pre-production hardening (Stage 2.10 decision D5), not waived it.
    const user = await h.account();
    const first = tokenFrom(await h.login(user.email));
    await h.login(user.email, PASSWORD, { cookie: cookieHeader(first) });
    expect((await h.me(first)).status).toBe(200);
    expect(await h.liveSessions(user.id)).toBe(2);
  });
});

describe('SES-03 concurrent logout', () => {
  const CONCURRENCY = 8;

  it('INVARIANT: concurrent logouts of one session are all answered 204, revoke it once, and write one LOGOUT event', async () => {
    // The existing contract (AuthService.logout): idempotent. The session is revoked by a single conditional UPDATE
    // (revokedAt IS NULL), the event is written only by the call that actually revoked it, and a call that finds it
    // already revoked is a no-op that keeps the original timestamp. This test asserts that contract under contention.
    const user = await h.account();
    const target = tokenFrom(await h.login(user.email));
    const other = tokenFrom(await h.login(user.email));

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => h.logout(target)),
    );
    for (const response of responses) {
      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie().join(';')).toMatch(/Max-Age=0/);
    }

    const revoked = await sessionRow(target);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await h.events(user.id, 'LOGOUT')).toBe(1);

    // A later logout keeps the original revocation time and writes nothing new.
    const firstRevocation = revoked.revokedAt.getTime();
    expect((await h.logout(target)).status).toBe(204);
    expect((await sessionRow(target)).revokedAt.getTime()).toBe(firstRevocation);
    expect(await h.events(user.id, 'LOGOUT')).toBe(1);

    // Only the presented session was affected.
    expect((await h.me(target)).status).toBe(401);
    expect((await h.me(other)).status).toBe(200);
    expect(await h.liveSessions(user.id)).toBe(1);
  });

  it('INVARIANT: a logout racing /auth/me never produces a server error or a half-revoked state', async () => {
    const user = await h.account();
    const token = tokenFrom(await h.login(user.email));
    const calls = [
      ...Array.from({ length: 6 }, () => h.logout(token)),
      ...Array.from({ length: 6 }, () => h.me(token)),
    ];
    const results = await Promise.all(calls);
    for (const response of results.slice(0, 6)) expect(response.status).toBe(204);
    for (const response of results.slice(6)) expect([200, 401]).toContain(response.status);
    expect((await h.me(token)).status).toBe(401);
    expect(await h.events(user.id, 'LOGOUT')).toBe(1);
  });

  it('INVARIANT: concurrent logouts of different sessions each revoke their own session exactly once', async () => {
    const user = await h.account();
    const tokens = [];
    for (let index = 0; index < 4; index += 1) tokens.push(tokenFrom(await h.login(user.email)));
    const responses = await Promise.all(
      tokens.flatMap((token) => [h.logout(token), h.logout(token)]),
    );
    for (const response of responses) expect(response.status).toBe(204);
    expect(await h.liveSessions(user.id)).toBe(0);
    expect(await h.events(user.id, 'LOGOUT')).toBe(4);
  });
});

describe('SES-06 session lifetime, idle expiry and cap', () => {
  it('INVARIANT: a session lasts exactly seven days from creation and the cookie lifetime matches', async () => {
    const user = await h.account();
    const response = await h.login(user.email);
    const row = await sessionRow(tokenFrom(response));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(SESSION_LIFETIME_MS);
    const maxAge = Number(/Max-Age=(\d+)/.exec(response.headers.getSetCookie().join(';'))[1]);
    expect(maxAge).toBeLessThanOrEqual(SESSION_LIFETIME_MS / 1000);
    expect(maxAge).toBeGreaterThan(SESSION_LIFETIME_MS / 1000 - 60);
  });

  it('CHARACTERIZATION: using a session never extends it and never records activity (no sliding expiry, lastSeenAt stays null)', async () => {
    const user = await h.account();
    const token = tokenFrom(await h.login(user.email));
    const before = await sessionRow(token);
    for (let index = 0; index < 3; index += 1) expect((await h.me(token)).status).toBe(200);
    const after = await sessionRow(token);
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.lastSeenAt).toBeNull();
  });

  it('CHARACTERIZATION: there is no idle expiry - a session unused for almost its whole life is still valid (deferred, not waived)', async () => {
    // Owner decision D5: the absolute seven-day lifetime is accepted for Stage 2 development acceptance; idle expiry
    // is deferred to pre-production hardening. This pins the current behaviour so adding idle expiry is a visible
    // decision. It does NOT say that a stolen but unused cookie staying valid for a week is acceptable in production.
    const user = await h.account();
    const token = generateSessionToken();
    const createdAt = new Date(Date.now() - 6.5 * 24 * 60 * 60 * 1000);
    await h.db.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + SESSION_LIFETIME_MS),
        lastSeenAt: null,
      },
    });
    expect((await h.me(token)).status).toBe(200);
  });

  it('INVARIANT: expiry is absolute and enforced by the server even for a freshly used session', async () => {
    const user = await h.account();
    const token = generateSessionToken();
    const createdAt = new Date(Date.now() - SESSION_LIFETIME_MS - 1000);
    await h.db.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + SESSION_LIFETIME_MS),
        lastSeenAt: new Date(),
      },
    });
    expect((await h.me(token)).status).toBe(401);
  });

  it('CHARACTERIZATION: there is no per-user session cap (deferred, not waived)', async () => {
    // Sixty concurrent sessions for one user, all valid. Beyond storage growth, a password reset must revoke every one
    // of them (and write one SESSION_REVOKED event each) inside one transaction, which is the Stage 2.7 fan-out limit.
    const user = await h.account();
    const sessions = new SessionService(h.db);
    const tokens = [];
    for (let index = 0; index < 60; index += 1)
      tokens.push((await sessions.createSession(user.id)).token);
    expect(await h.liveSessions(user.id)).toBe(60);
    expect((await h.me(tokens[0])).status).toBe(200);
    expect((await h.me(tokens[59])).status).toBe(200);
  });
});

/** An HTTP request that opens its own connection, so a refused body can never poison a reused socket. */
function rawRequest(method, path, { headers = {}, body } = {}) {
  const url = new URL(h.origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        agent: false,
        headers: { connection: 'close', ...headers },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('request timed out')));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

describe('SES-07 unsupported HTTP methods', () => {
  const PATHS = {
    '/auth/login': 'POST',
    '/auth/me': 'GET',
    '/auth/logout': 'POST',
    '/auth/password/forgot': 'POST',
    '/auth/password/reset': 'POST',
  };
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'];
  const unsupported = Object.entries(PATHS).flatMap(([path, supported]) =>
    METHODS.filter(
      (method) => method !== supported && !(path === '/auth/me' && method === 'HEAD'),
    ).map((method) => [method, path]),
  );

  it.each(unsupported)(
    'INVARIANT: %s %s is never a success, sets no cookie, and grants no cross-origin access',
    async (method, path) => {
      const hasBody = ['PUT', 'PATCH', 'DELETE', 'POST'].includes(method);
      const result = await rawRequest(method, path, {
        headers: {
          origin: TRUSTED_ORIGIN,
          ...(hasBody ? { 'content-type': 'application/json', 'content-length': '2' } : {}),
        },
        ...(hasBody ? { body: '{}' } : {}),
      });
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.headers['set-cookie']).toBeUndefined();
      for (const name of Object.keys(result.headers)) {
        expect(name.startsWith('access-control-'), name).toBe(false);
      }
    },
  );

  it('CHARACTERIZATION: an unsupported method is answered with the framework default 404, not the fixed error vocabulary', async () => {
    // Today an unsupported method on an existing path answers 404 with Nest's default body, which names the method and
    // the path and the framework's wording, and carries no `Cache-Control: no-store` (that header is applied to routes
    // that exist). It leaks no credential or session material, but it is a small fingerprint and differs in shape from
    // every other authentication response. Pinned so changing it is a visible decision; not described as intended.
    const result = await rawRequest('PUT', '/auth/login', {
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: '{}',
    });
    expect(result.status).toBe(404);
    expect(JSON.parse(result.body)).toEqual({
      message: 'Cannot PUT /auth/login',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(result.headers['cache-control']).toBeUndefined();
    expect(result.headers['content-type']).toMatch(/^application\/json/);
  });

  it('CHARACTERIZATION: HEAD /auth/me is served by the GET handler (Express maps HEAD to GET) and returns no body', async () => {
    const user = await h.account();
    const token = tokenFrom(await h.login(user.email));
    const withCookie = await rawRequest('HEAD', '/auth/me', {
      headers: { cookie: cookieHeader(token) },
    });
    expect(withCookie.status).toBe(200);
    expect(withCookie.body).toBe('');
    expect(withCookie.headers['cache-control']).toBe('no-store');
    const without = await rawRequest('HEAD', '/auth/me');
    expect(without.status).toBe(401);
  });

  it('INVARIANT: a GET, PUT, PATCH, DELETE, OPTIONS, HEAD or TRACE to /auth/logout never revokes the session', async () => {
    const user = await h.account();
    const token = tokenFrom(await h.login(user.email));
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE']) {
      const result = await rawRequest(method, '/auth/logout', {
        headers: { origin: TRUSTED_ORIGIN, cookie: cookieHeader(token) },
      });
      expect(result.status, method).toBeGreaterThanOrEqual(400);
    }
    expect((await h.me(token)).status).toBe(200);
    expect(await h.events(user.id, 'LOGOUT')).toBe(0);
  });

  it('INVARIANT: valid credentials sent by an unsupported method create no session', async () => {
    const user = await h.account();
    const credentials = JSON.stringify({ email: user.email, password: PASSWORD });
    const query = new URLSearchParams({ email: user.email, password: PASSWORD }).toString();
    const attempts = [
      ['GET', `/auth/login?${query}`, undefined],
      ['HEAD', `/auth/login?${query}`, undefined],
      ['PUT', '/auth/login', credentials],
      ['PATCH', '/auth/login', credentials],
      ['DELETE', '/auth/login', credentials],
    ];
    for (const [method, path, body] of attempts) {
      const result = await rawRequest(method, path, {
        headers: {
          origin: TRUSTED_ORIGIN,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(body.length) }),
        },
        ...(body === undefined ? {} : { body }),
      });
      expect(result.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(result.headers['set-cookie']).toBeUndefined();
    }
    expect(await h.db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await h.events(user.id)).toBe(0);
  });

  it('INVARIANT: a live recovery token sent by an unsupported method is not consumed and the password is unchanged', async () => {
    const user = await h.account();
    const token = generateRecoveryToken();
    await h.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRecoveryToken(token),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const before = await h.db.passwordCredential.findUnique({ where: { userId: user.id } });
    const body = JSON.stringify({ token, newPassword: 'a brand new password value' });
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const result = await rawRequest(method, '/auth/password/reset', {
        headers: {
          origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
        body,
      });
      expect(result.status, method).toBeGreaterThanOrEqual(400);
    }
    const after = await h.db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    const row = await h.db.passwordResetToken.findUnique({
      where: { tokenHash: hashRecoveryToken(token) },
    });
    expect(row.usedAt).toBeNull();
    expect(await h.events(user.id)).toBe(0);
  });

  it('INVARIANT: requests to unsupported methods neither spend nor reset the login limiter', async () => {
    const user = await h.account();
    for (let index = 0; index < 15; index += 1) {
      await rawRequest('PUT', '/auth/login', {
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: '{}',
      });
    }
    // 15 unsupported requests would exhaust a 10-per-5-minutes source bucket if they were metered.
    expect((await h.login(user.email)).status).toBe(200);
  });
});

describe('IDC-04 password encoding over HTTP', () => {
  const COMPOSED = 'é'.repeat(15); // 15 code points: "e" with acute, precomposed
  const DECOMPOSED = COMPOSED.normalize('NFD'); // the same visible text, 30 code points

  it('CHARACTERIZATION: a password set in composed form does not log in when the client sends it decomposed', async () => {
    // The password is compared byte for byte, with no Unicode normalization (the unit suite pins the hashing side).
    // The visible consequence is that the same typed password can fail on a client or keyboard that emits the other
    // form. This is not an authentication bypass: the refusal is the ordinary 401 and charges the failure meters. It is
    // a usability and lock-out hazard, and normalization is an owner decision that has not been taken.
    const user = await h.account({ password: COMPOSED });
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect((await h.login(user.email, COMPOSED)).status).toBe(200);
    const refused = await h.login(user.email, DECOMPOSED);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ statusCode: 401, error: 'authentication_failed' });
  });

  it('CHARACTERIZATION: the reverse also holds - a decomposed password does not match its composed form', async () => {
    const user = await h.account({ password: DECOMPOSED });
    expect((await h.login(user.email, DECOMPOSED)).status).toBe(200);
    expect((await h.login(user.email, COMPOSED)).status).toBe(401);
  });

  it('INVARIANT: the refusal for the other normalization form is indistinguishable from any wrong password', async () => {
    const user = await h.account({ password: COMPOSED });
    const form = await h.login(user.email, DECOMPOSED);
    const wrong = await h.login(user.email, 'entirely different secret phrase');
    expect(form.status).toBe(wrong.status);
    expect(await form.json()).toEqual(await wrong.json());
    expect(
      [...form.headers.keys()]
        .filter((k) => k !== 'date' && k !== 'x-request-id' && k !== 'etag')
        .sort(),
    ).toEqual(
      [...wrong.headers.keys()]
        .filter((k) => k !== 'date' && k !== 'x-request-id' && k !== 'etag')
        .sort(),
    );
  });
});
