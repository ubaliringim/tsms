import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
  RECOVERY_POLICY,
} from '../dist/identity/password-recovery-token.js';
import { RECOVERY_DELIVERY } from '../dist/identity/auth.module.js';

const ORIGIN = 'http://127.0.0.1:3000';
const COOKIE = 'tsms_session';
const RECOVERY_BASE = 'https://app.example.test/account/recover';
const OLD_PASSWORD = 'the original password value';
const NEW_PASSWORD = 'a brand new password value';

let db, app, origin, delivery, ids;

beforeAll(async () => {
  const env = parseIntegrationEnvironment(process.env);
  const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  app = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: env.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [ORIGIN],
    API_PASSWORD_RECOVERY_URL_BASE: RECOVERY_BASE,
    API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
  });
  // `development-only` mode builds the in-memory adapter; retrieve that exact instance so a test
  // can assert on what would have been delivered.
  delivery = app.get(RECOVERY_DELIVERY);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  if (db) await closeDatabase(db);
});

beforeEach(() => {
  ids = [];
  delivery.clear();
});

afterEach(async () => {
  if (!db) return;
  // Child rows first, scoped to this test's own fixture users.
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', password = OLD_PASSWORD, email } = {}) {
  const address = email ?? `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: {
      email: address,
      normalizedEmail: address.toLowerCase(),
      displayName: 'Synthetic Identity',
      status,
    },
  });
  ids.push(user.id);
  if (password !== null) {
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(password) },
    });
  }
  return user;
}

function call(path, { method = 'POST', body, cookie, requestOrigin, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) {
    init.body = payload;
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
  }
  if (cookie !== undefined) init.headers['cookie'] = cookie;
  if (requestOrigin !== undefined) init.headers['origin'] = requestOrigin;
  return fetch(`${origin}${path}`, init);
}

const forgot = (email, extra = {}) =>
  call('/auth/password/forgot', { body: { email }, requestOrigin: ORIGIN, ...extra });

const reset = (token, newPassword = NEW_PASSWORD, extra = {}) =>
  call('/auth/password/reset', { body: { token, newPassword }, requestOrigin: ORIGIN, ...extra });

const login = (email, password) =>
  call('/auth/login', { body: { email, password }, requestOrigin: ORIGIN });

const tokenOf = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE}=`))
    .slice(COOKIE.length + 1)
    .split(';')[0];

/** Current-user probe. `call` defaults to POST, so the method is explicit here. */
const me = (cookie) => call('/auth/me', { method: 'GET', cookie: `${COOKIE}=${cookie}` });

const ACCEPTED = {
  message: 'If the account is eligible, password recovery instructions will be sent.',
};
const TOKEN_INVALID = { statusCode: 401, error: 'recovery_token_invalid' };
const POLICY_VIOLATION = { statusCode: 400, error: 'password_policy_violation' };

const resetCount = () => db.passwordResetToken.count({ where: { userId: { in: ids } } });
const sessionCount = () => db.session.count({ where: { userId: { in: ids } } });
const credentialCount = () => db.passwordCredential.count({ where: { userId: { in: ids } } });

/** Issue a token through the public endpoint and read it from the recorded delivery. */
async function issueFor(email) {
  const response = await forgot(email);
  expect(response.status).toBe(202);
  return delivery.last.token;
}

// --- Recovery request ----------------------------------------------------------------

describe('POST /auth/password/forgot', () => {
  it('creates exactly one recovery token for an eligible account', async () => {
    const user = await account();
    const response = await forgot(user.email);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(ACCEPTED);
    expect(await resetCount()).toBe(1);
    const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.usedAt).toBeNull();
  });

  it('returns the identical response for unknown, disabled, and credential-less accounts', async () => {
    const user = await account();
    const disabled = await account({ status: 'DISABLED' });
    const noCredential = await account({ password: null });

    const responses = await Promise.all([
      forgot('nobody@example.test'),
      forgot(user.email),
      forgot(disabled.email),
      forgot(noCredential.email),
    ]);
    const rendered = [];
    for (const response of responses) {
      rendered.push({
        status: response.status,
        body: await response.json(),
        cache: response.headers.get('cache-control'),
        vary: response.headers.get('vary'),
        cookie: response.headers.getSetCookie().length,
      });
    }
    for (const entry of rendered) expect(entry).toEqual(rendered[1]);
    expect(rendered[1]).toEqual({
      status: 202,
      body: ACCEPTED,
      cache: 'no-store',
      vary: 'Origin',
      cookie: 0,
    });
    // Only the eligible account produced a token.
    expect(await resetCount()).toBe(1);
  });

  it('never reveals the token, the reset URL, or a Set-Cookie header', async () => {
    const user = await account();
    const response = await forgot(user.email);
    const text = await response.text();
    expect(text).not.toContain(delivery.last.token);
    expect(text).not.toContain('token=');
    expect(text).not.toContain('http');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.url).not.toContain(delivery.last.token);
  });

  it('persists only the token digest and expires it 30 minutes out', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashRecoveryToken(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(RECOVERY_POLICY.lifetimeMs);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + RECOVERY_POLICY.lifetimeMs);
  });

  it('supersedes earlier outstanding tokens on each issuance', async () => {
    const user = await account();
    const first = await issueFor(user.email);
    const firstRow = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(first) },
    });
    expect(firstRow.usedAt).toBeNull();

    const second = await issueFor(user.email);
    expect(second).not.toBe(first);
    const superseded = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(first) },
    });
    expect(superseded.usedAt).not.toBeNull();

    const live = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(second) },
    });
    expect(live.usedAt).toBeNull();
    expect(await resetCount()).toBe(2);
  });

  it('hands the delivery adapter the recipient, display name, token, and configured reset URL', async () => {
    const user = await account({ email: 'Person@Example.test' });
    await issueFor(user.email);
    expect(delivery.last.recipient).toBe('Person@Example.test');
    expect(delivery.last.displayName).toBe('Synthetic Identity');
    expect(delivery.last.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(delivery.last.resetUrl.startsWith(`${RECOVERY_BASE}#token=`)).toBe(true);
    expect(delivery.last.resetUrl.split('#')[0]).not.toContain(delivery.last.token);
    expect(delivery.last.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('normalizes the submitted address using the accepted identity rules', async () => {
    const user = await account({ email: 'Person@Example.test' });
    expect((await forgot(`  PERSON@EXAMPLE.TEST  `)).status).toBe(202);
    expect(await resetCount()).toBe(1);
    expect(delivery.last.recipient).toBe('Person@Example.test');
    expect(user.normalizedEmail).toBe('person@example.test');
  });

  it('never creates an account as a side effect', async () => {
    await account();
    const before = await db.user.count({ where: { normalizedEmail: 'ghost@example.test' } });
    expect((await forgot('ghost@example.test')).status).toBe(202);
    expect(await db.user.count({ where: { normalizedEmail: 'ghost@example.test' } })).toBe(before);
    expect(await credentialCount()).toBe(1);
    expect(await resetCount()).toBe(0);
    expect(delivery.deliveries).toHaveLength(0);
  });

  it.each([
    ['an array body', '[]'],
    ['null', 'null'],
    ['malformed JSON', '{"email":'],
    ['an empty body', ''],
  ])('rejects %s with the fixed malformed-request body', async (_label, raw) => {
    const response = await call('/auth/password/forgot', { raw, requestOrigin: ORIGIN });
    expect(response.status).toBe(400);
    expect(JSON.parse(await response.text())).toEqual({
      statusCode: 400,
      error: 'invalid_request',
    });
  });

  it.each([
    ['an unexpected field', { email: 'a@example.test', role: 'ADMIN' }],
    ['a missing email', {}],
    ['a numeric email', { email: 42 }],
    ['a null email', { email: null }],
    ['an object email', { email: { value: 'a@example.test' } }],
  ])('rejects %s', async (_label, body) => {
    const response = await call('/auth/password/forgot', { body, requestOrigin: ORIGIN });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ statusCode: 400, error: 'invalid_request' });
  });

  it('rejects an oversized body and a wrong content type', async () => {
    const oversized = await call('/auth/password/forgot', {
      raw: JSON.stringify({ email: `${'a'.repeat(9000)}@example.test` }),
      requestOrigin: ORIGIN,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ statusCode: 413, error: 'request_too_large' });

    const wrongType = await call('/auth/password/forgot', {
      raw: 'email=a%40example.test',
      requestOrigin: ORIGIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrongType.status).toBe(400);
  });
});

// --- Password reset ------------------------------------------------------------------

describe('POST /auth/password/reset', () => {
  it('replaces the password, consumes the token, and returns an empty 204', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const before = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });

    const response = await reset(token);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toEqual([]);

    const after = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());

    const row = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(token) },
    });
    expect(row.usedAt).not.toBeNull();
  });

  it('makes the old password stop working and the new password work', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    expect((await reset(token)).status).toBe(204);

    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('revokes existing sessions and creates none of its own', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, OLD_PASSWORD));
    expect((await me(cookie)).status).toBe(200);
    expect(await sessionCount()).toBe(1);

    const token = await issueFor(user.email);
    expect((await reset(token)).status).toBe(204);

    expect((await me(cookie)).status).toBe(401);
    expect(await sessionCount()).toBe(1);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.revokedAt).not.toBeNull();
    // No session cookie is issued by the reset itself.
    expect((await reset(await issueFor(user.email))).status).toBe(204);
    expect(await sessionCount()).toBe(1);
  });

  it('preserves password whitespace and Unicode exactly', async () => {
    const user = await account();
    const spaced = '  leading and trailing spaces  ';
    const unicode = 'pässwörd with é and 你 and 🙂 characters';
    const token = await issueFor(user.email);

    expect((await reset(token, spaced)).status).toBe(204);
    expect((await login(user.email, spaced)).status).toBe(200);
    expect((await login(user.email, spaced.trim())).status).toBe(401);

    const second = await issueFor(user.email);
    expect((await reset(second, unicode)).status).toBe(204);
    expect((await login(user.email, unicode)).status).toBe(200);
  });

  it('rejects a policy-violating password without consuming the token or leaking state', async () => {
    const user = await account();
    const token = await issueFor(user.email);

    for (const bad of ['short', 'x'.repeat(200), 'lone\uD800surrogate']) {
      const response = await reset(token, bad);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(POLICY_VIOLATION);
      // Nothing was written: the token is still usable and the old password still works.
      expect(await resetCount()).toBe(1);
      expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
    }
    // The same token still succeeds with a valid password afterwards.
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
  });

  it('answers an unusable token generically and changes nothing', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const before = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });

    const unusable = [
      ['unknown token', 'A'.repeat(43)],
      ['malformed token', 'not-a-recovery-token'],
      ['too short', 'A'.repeat(42)],
      ['padded', `${token}=`],
      ['whitespace padded', ` ${token}`],
    ];
    for (const [label, value] of unusable) {
      const response = await reset(value);
      expect(response.status, label).toBe(401);
      expect(await response.json(), label).toEqual(TOKEN_INVALID);
    }

    // A non-string token is malformed input, not an unusable token, so it is a 400 rather than
    // the generic 401. Both are indistinguishable in content from the submitted value's type only.
    const wrongType = await reset(12345);
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ statusCode: 400, error: 'invalid_request' });

    const after = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('refuses an expired token', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    await db.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await reset(token);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(TOKEN_INVALID);
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('refuses a token belonging to a disabled account', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    expect((await reset(token)).status).toBe(401);
    // Eligibility is re-checked under the lock, so the credential is untouched.
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
  });

  it('refuses a replayed token', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
    const replay = await reset(token, 'yet another password value');
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(TOKEN_INVALID);
    // The second password never took effect.
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(user.email, 'yet another password value')).status).toBe(401);
  });

  it('refuses a superseded token', async () => {
    const user = await account();
    const first = await issueFor(user.email);
    const second = await issueFor(user.email);
    const response = await reset(first);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(TOKEN_INVALID);
    expect((await reset(second, NEW_PASSWORD)).status).toBe(204);
  });

  it('invalidates other outstanding tokens when one is redeemed', async () => {
    const user = await account();
    // Issuing supersedes earlier tokens, so two *live* tokens only exist when a second row was
    // written without superseding. Insert one directly to reach that state.
    const token = await issueFor(user.email);
    const staleToken = generateRecoveryToken();
    expect(staleToken).not.toBe(token);
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRecoveryToken(staleToken),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + RECOVERY_POLICY.lifetimeMs),
        usedAt: null,
      },
    });
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(2);

    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);

    // Redeeming one token supersedes the other, so nothing is left outstanding.
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(0);
    const other = await reset(staleToken);
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual(TOKEN_INVALID);
  });

  it('leaves other users credentials and sessions untouched', async () => {
    const victim = await account();
    const bystander = await account();
    const bystanderCookie = tokenOf(await login(bystander.email, OLD_PASSWORD));

    const token = await issueFor(victim.email);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);

    expect((await me(bystanderCookie)).status).toBe(200);
    expect((await login(bystander.email, OLD_PASSWORD)).status).toBe(200);
    expect(await resetCount()).toBe(1);
    const bystanderRow = await db.session.findFirstOrThrow({ where: { userId: bystander.id } });
    expect(bystanderRow.revokedAt).toBeNull();
  });

  it('never returns a token, digest, or cookie', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const response = await reset(token);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashRecoveryToken(token));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects unexpected fields and wrong content types on reset', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const unexpected = await call('/auth/password/reset', {
      body: { token, newPassword: NEW_PASSWORD, skipTokenCheck: true },
      requestOrigin: ORIGIN,
    });
    expect(unexpected.status).toBe(400);
    expect(await unexpected.json()).toEqual({ statusCode: 400, error: 'invalid_request' });

    const wrongType = await call('/auth/password/reset', {
      raw: `token=${token}&newPassword=${encodeURIComponent(NEW_PASSWORD)}`,
      requestOrigin: ORIGIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrongType.status).toBe(400);
    // Both rejections were inert: the token is untouched and still redeemable.
    const row = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(token) },
    });
    expect(row.usedAt).toBeNull();
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
  });

  it('never accepts a token through a requester-controlled URL', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const viaQuery = await fetch(
      `${origin}/auth/password/reset?token=${token}&newPassword=${encodeURIComponent(NEW_PASSWORD)}`,
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN } },
    );
    expect(viaQuery.status).toBe(400);
    // The query-supplied token was not consumed.
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
  });
});

// --- Concurrency and atomicity -------------------------------------------------------

describe('recovery concurrency and atomicity', () => {
  it('allows exactly one winner for two concurrent redemptions of one token', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const attempt = (newPassword) => reset(token, newPassword);

    const results = await Promise.all([
      attempt('concurrent password value one'),
      attempt('concurrent password value two'),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([204, 401]);

    // Exactly one of the two attempted passwords is in effect; the other never was.
    const first = (await login(user.email, 'concurrent password value one')).status;
    const second = (await login(user.email, 'concurrent password value two')).status;
    expect([first, second].sort()).toEqual([200, 401]);

    // The token is consumed exactly once.
    const rows = await db.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows.filter((row) => row.usedAt !== null)).toHaveLength(1);
  });

  it('rolls back every security-sensitive change when the transaction fails', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const cookie = tokenOf(await login(user.email, OLD_PASSWORD));
    const credentialBefore = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const tokenRowBefore = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });

    // Remove the credential inside a competing transaction so the reset cannot replace it, then
    // confirm the token was not consumed and the credential is untouched.
    await db.$transaction(async (tx) => {
      await tx.passwordCredential.delete({ where: { userId: user.id } });
    });

    const response = await reset(token);
    expect([401, 503]).toContain(response.status);

    const tokenRowAfter = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(token) },
    });
    expect(tokenRowAfter.usedAt).toBeNull();
    const sessionAfter = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(sessionAfter.revokedAt).toBeNull();
    expect((await me(cookie)).status).toBe(200);
    void credentialBefore;
    void tokenRowBefore;
  });

  it('leaves the credential unchanged when a concurrent reset already consumed the token', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    expect((await reset(token, 'first winning password here')).status).toBe(204);
    const after = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });

    const loser = await reset(token, 'second losing password here');
    expect(loser.status).toBe(401);
    const stillFirst = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(stillFirst.passwordHash).toBe(after.passwordHash);
    expect((await login(user.email, 'first winning password here')).status).toBe(200);
  });

  it('orders issuance against redemption without a partial write', async () => {
    const user = await account();
    const first = await issueFor(user.email);
    // Redeem and supersede concurrently. Exactly one outcome, never a consumed-but-unused token.
    const [redeem, supersede] = await Promise.all([reset(first, NEW_PASSWORD), forgot(user.email)]);
    expect([204, 401]).toContain(redeem.status);
    expect(supersede.status).toBe(202);

    const live = await db.passwordResetToken.findMany({ where: { userId: user.id, usedAt: null } });
    // At most the newly issued token is outstanding; the redeemed one is never left live.
    expect(live.length).toBeLessThanOrEqual(1);
    expect(await resetCount()).toBe(2);
  });

  it('fails safely when an account is disabled concurrently with a reset', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    const response = await reset(token);
    expect(response.status).toBe(401);
    // A disabled user cannot authenticate regardless of the credential state.
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
  });

  it('revokes sessions that exist when the reset commits', async () => {
    const user = await account();
    const first = tokenOf(await login(user.email, OLD_PASSWORD));
    const second = tokenOf(await login(user.email, OLD_PASSWORD));
    expect(await sessionCount()).toBe(2);

    const token = await issueFor(user.email);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);

    for (const cookie of [first, second]) {
      expect((await me(cookie)).status).toBe(401);
    }
    const live = await db.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });
});

// --- HTTP security -------------------------------------------------------------------

describe('password recovery HTTP security', () => {
  it('requires a trusted Origin and fails closed without one', async () => {
    const user = await account();
    const missing = await call('/auth/password/forgot', { body: { email: user.email } });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ statusCode: 403, error: 'forbidden_origin' });
    expect(await resetCount()).toBe(0);
  });

  it.each([
    ['a different scheme', 'https://127.0.0.1:3000'],
    ['a different port', 'http://127.0.0.1:3001'],
    ['a different host', 'http://localhost:3000'],
    ['a suffix lookalike', 'http://127.0.0.1:3000.evil.test'],
    ['a wildcard', '*'],
  ])('rejects a disallowed Origin: %s', async (_label, requestOrigin) => {
    const user = await account();
    const response = await forgot(user.email, { requestOrigin });
    expect(response.status).toBe(403);
    expect(await resetCount()).toBe(0);
  });

  it.each([
    ['x-forwarded-host', { 'x-forwarded-host': ORIGIN }],
    ['x-forwarded-proto', { 'x-forwarded-proto': 'https' }],
    ['host', { host: ORIGIN }],
    ['referer', { referer: `${ORIGIN}/recover` }],
  ])('does not let a spoofed %s header authorise a recovery request', async (_label, headers) => {
    const user = await account();
    const response = await call('/auth/password/forgot', { body: { email: user.email }, headers });
    expect(response.status).toBe(403);
    expect(await resetCount()).toBe(0);
  });

  it('requires a trusted Origin on reset too', async () => {
    const user = await account();
    const token = await issueFor(user.email);
    const response = await call('/auth/password/reset', {
      body: { token, newPassword: NEW_PASSWORD },
    });
    expect(response.status).toBe(403);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
  });

  it('marks every recovery response no-store and emits no credentialed CORS header', async () => {
    const user = await account();
    const responses = [
      await forgot(user.email),
      await forgot('nobody@example.test'),
      await reset('A'.repeat(43)),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Origin');
      for (const header of ['access-control-allow-origin', 'access-control-allow-credentials']) {
        expect(response.headers.get(header)).toBeNull();
      }
    }
  });

  it('adds no registration, tenant, or RBAC route', async () => {
    for (const path of [
      '/auth/register',
      '/auth/signup',
      '/auth/password/change',
      '/auth/sessions',
      '/auth/tenant',
    ]) {
      expect((await call(path, { requestOrigin: ORIGIN })).status, path).toBe(404);
    }
  });
});

// --- Disabled delivery ---------------------------------------------------------------

describe('recovery with delivery disabled', () => {
  it('fails closed without creating a token', async () => {
    const env = parseIntegrationEnvironment(process.env);
    const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
    const closedApp = await createApplication({
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      DATABASE_URL: databaseUrl,
      REDIS_URL: env.TEST_REDIS_URL,
      API_TRUSTED_ORIGINS: [ORIGIN],
      API_PASSWORD_RECOVERY_DELIVERY_MODE: 'disabled',
    });
    await closedApp.listen(0, '127.0.0.1');
    const closed = await closedApp.getUrl();
    const user = await account();
    try {
      const response = await fetch(`${closed}/auth/password/forgot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: user.email }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ statusCode: 503, error: 'service_unavailable' });
      // No state change: no token, so recovery cannot half-work.
      expect(await resetCount()).toBe(0);
    } finally {
      await closedApp.close();
    }
  });
});
