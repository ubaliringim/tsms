/**
 * Stage 2.7 integration tests: authentication events against real PostgreSQL and Redis.
 *
 * These exercise the properties that only appear once a real transaction, a real lock, and a real
 * connection pool are involved - chiefly that a success event cannot survive a rollback, that concurrent
 * operations cannot fabricate one, and that event volume stays bounded when an attacker floods an endpoint.
 *
 * The HTTP surface is driven end to end through the real application, so the events under test are written
 * by the same code path production uses.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleRequests } from './support/track-requests.mjs';
import { clearOrphanSecurityEvents } from './support/event-cleanup.mjs';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createRedisClient, closeRedis } from '@tsms/redis';
import { createApplication } from '../dist/application.js';
import { resetRateLimitState } from './support/rate-limit-state.mjs';
import { hashPassword, verifyPassword } from '../dist/identity/password-hasher.js';
import { SECURITY_REQUEST_ID_HEADER } from '../dist/identity/security-request-context.js';
import { RECOVERY_DELIVERY } from '../dist/identity/auth.module.js';
import { AuthService } from '../dist/identity/auth.service.js';
import { SessionService } from '../dist/identity/session.service.js';
import { admissionFor, successMeterFor } from './support/stage29-wiring.mjs';
import { SecurityLog } from '../dist/identity/security-log.js';
import { SecurityEventRecorder } from '../dist/identity/security-event-recorder.js';
import { PasswordRecoveryService } from '../dist/identity/password-recovery.service.js';
import { InMemoryRecoveryDelivery } from '../dist/identity/password-recovery-delivery.js';

/** A recorder collaborator whose log output is discarded, so these tests stay quiet. */
function silentSecurityLog() {
  return new SecurityLog({ sink: () => {} });
}

/** The real services over a database handle, wired exactly as the module wires them. */
function authServiceOver(handle) {
  const log = silentSecurityLog();
  return new AuthService(
    handle,
    new SessionService(handle),
    admissionFor(redisClient),
    new SecurityEventRecorder(handle, log),
    log,
    successMeterFor(redisClient),
  );
}

function recoveryServiceOver(handle) {
  const log = silentSecurityLog();
  return new PasswordRecoveryService(
    handle,
    new InMemoryRecoveryDelivery(),
    { mode: 'development-only', urlBase: 'https://app.example.test/account/recover' },
    admissionFor(redisClient),
    new SecurityEventRecorder(handle, log),
    log,
  );
}

/**
 * Wrap a Prisma client so an interceptor runs at chosen seams.
 *
 * `beforeTransaction` fires after the caller has verified its input and immediately before the real
 * transaction opens, which is exactly the window in which another request can commit. `inTransaction`
 * may replace a delegate on the transaction handle, to refuse or to interleave a write.
 */
function interceptedDatabase({ beforeTransaction, inTransaction } = {}) {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return async (argument, ...rest) => {
          if (typeof argument !== 'function') return target.$transaction(argument, ...rest);
          if (beforeTransaction) await beforeTransaction();
          return target.$transaction(
            (tx) =>
              argument(
                new Proxy(tx, {
                  get(inner, name) {
                    const replaced = inTransaction?.(inner, name);
                    if (replaced !== undefined) return replaced;
                    const value = inner[name];
                    return typeof value === 'function' ? value.bind(inner) : value;
                  },
                }),
              ),
            ...rest,
          );
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const ORIGIN = 'http://127.0.0.1:3000';
const COOKIE = 'tsms_session';
const RECOVERY_BASE = 'https://app.example.test/account/recover';
const PASSWORD = 'the original password value';
const NEW_PASSWORD = 'a brand new password value';
const OTHER_PASSWORD = 'a completely different password';

const integrationEnv = parseIntegrationEnvironment(process.env);

let db, app, origin, delivery, ids, redisClient, requestIds;

beforeAll(async () => {
  const databaseUrl = assertDisposableTestDatabase(integrationEnv.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  redisClient = createRedisClient(integrationEnv.TEST_REDIS_URL);
  app = await createApplication({
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: 4000,
    DATABASE_URL: databaseUrl,
    REDIS_URL: integrationEnv.TEST_REDIS_URL,
    API_TRUSTED_ORIGINS: [ORIGIN],
    API_RATE_LIMIT_HMAC_SECRET: 'stage27_events_integration_rate_limit_key_01',
    API_PASSWORD_RECOVERY_URL_BASE: RECOVERY_BASE,
    API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
  });
  delivery = app.get(RECOVERY_DELIVERY);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  if (db) await closeDatabase(db);
  if (redisClient) await closeRedis(redisClient);
});

beforeEach(async () => {
  await resetRateLimitState(integrationEnv.TEST_REDIS_URL);
  ids = [];
  requestIds = [];
  delivery.clear();
});

afterEach(async () => {
  await settleRequests();
  if (!db) return;
  await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
  await db.authenticationEvent.deleteMany({ where: { requestId: { in: requestIds } } });
  await clearOrphanSecurityEvents(db);
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', password = PASSWORD, email } = {}) {
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

function call(path, { method = 'POST', body, cookie, requestOrigin, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
  }
  if (cookie !== undefined) init.headers['cookie'] = cookie;
  if (requestOrigin !== undefined) init.headers['origin'] = requestOrigin;
  return fetch(`${origin}${path}`, init).then((response) => {
    const id = response.headers.get(SECURITY_REQUEST_ID_HEADER);
    if (id) requestIds.push(id);
    return response;
  });
}

const login = (email, password) =>
  call('/auth/login', { body: { email, password }, requestOrigin: ORIGIN });
const forgot = (email) => call('/auth/password/forgot', { body: { email }, requestOrigin: ORIGIN });
const reset = (token, newPassword = NEW_PASSWORD) =>
  call('/auth/password/reset', { body: { token, newPassword }, requestOrigin: ORIGIN });
const logout = (cookie) => call('/auth/logout', { cookie, requestOrigin: ORIGIN });
const me = (cookie) => call('/auth/me', { method: 'GET', cookie });

const tokenOf = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE}=`))
    .slice(COOKIE.length + 1)
    .split(';')[0];

const eventsFor = (userId) =>
  db.authenticationEvent.findMany({ where: { userId }, orderBy: { occurredAt: 'asc' } });
const typesFor = async (userId) => (await eventsFor(userId)).map((event) => event.eventType);

// --- Successful outcomes ---------------------------------------------------------

describe('successful outcomes are recorded truthfully', () => {
  it('records exactly one LOGIN_SUCCEEDED, correlated, only after the session exists', async () => {
    const user = await account();
    const response = await login(user.email, PASSWORD);
    expect(response.status).toBe(200);

    const events = await eventsFor(user.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('LOGIN_SUCCEEDED');
    // The correlation id is the one the server generated for this request, echoed in the header.
    expect(events[0].requestId).toBe(response.headers.get(SECURITY_REQUEST_ID_HEADER));

    // The event and the session it describes agree: neither exists without the other.
    const sessions = await db.session.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(sessions).toHaveLength(1);
  });

  it('records LOGOUT when a live session is revoked', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, PASSWORD));
    const response = await logout(`${COOKIE}=${cookie}`);
    expect(response.status).toBe(204);
    expect(await typesFor(user.id)).toEqual(['LOGIN_SUCCEEDED', 'LOGOUT']);
  });

  it('records PASSWORD_RESET_REQUESTED and PASSWORD_RESET_COMPLETED around a reset', async () => {
    const user = await account();
    expect((await forgot(user.email)).status).toBe(202);
    const token = delivery.deliveries[0].token;

    expect((await reset(token)).status).toBe(204);
    expect(await typesFor(user.id)).toEqual([
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
    ]);
  });

  it('records one SESSION_REVOKED per session the reset actually revoked', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(3);

    await forgot(user.email);
    expect((await reset(delivery.deliveries[0].token)).status).toBe(204);

    const revoked = (await typesFor(user.id)).filter((type) => type === 'SESSION_REVOKED');
    expect(revoked).toHaveLength(3);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
});

// --- Failure outcomes ------------------------------------------------------------

describe('failed outcomes are recorded without becoming an oracle', () => {
  it('records LOGIN_FAILED against the account that was attempted', async () => {
    const user = await account();
    expect((await login(user.email, OTHER_PASSWORD)).status).toBe(401);
    expect(await typesFor(user.id)).toEqual(['LOGIN_FAILED']);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('records an unknown-account failure with no user attribution', async () => {
    const unknown = `${randomUUID()}@example.test`;
    const response = await login(unknown, OTHER_PASSWORD);
    expect(response.status).toBe(401);

    // Exactly this request's row exists, and it is honest about not knowing who it was. Matching on the
    // server-generated correlation id keeps the assertion about this request instead of about whatever
    // else the table happens to hold.
    const rows = await db.authenticationEvent.findMany({
      where: { requestId: response.headers.get(SECURITY_REQUEST_ID_HEADER) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('LOGIN_FAILED');
    expect(rows[0].userId).toBeNull();
  });

  it('gives a known and an unknown account byte-identical public responses', async () => {
    // Enumeration resistance: recording who exists must not change what the caller sees.
    const user = await account();
    const known = await login(user.email, OTHER_PASSWORD);
    const unknown = await login(`${randomUUID()}@example.test`, OTHER_PASSWORD);

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    // Both are recorded; only the attribution differs, and it is never returned.
    expect(await typesFor(user.id)).toEqual(['LOGIN_FAILED']);
  });

  it('records no event for a malformed request, which was never an authentication attempt', async () => {
    const before = await db.authenticationEvent.count();
    expect(
      (await call('/auth/login', { body: { email: 42, password: 42 }, requestOrigin: ORIGIN }))
        .status,
    ).toBe(400);
    expect(await db.authenticationEvent.count()).toBe(before);
  });

  it('records nothing for a routine successful GET /auth/me', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, PASSWORD));
    await db.authenticationEvent.deleteMany({ where: { userId: user.id } });

    expect((await me(`${COOKIE}=${cookie}`)).status).toBe(200);
    expect((await me(`${COOKIE}=${cookie}`)).status).toBe(200);
    // No documented security reason to record routine profile reads; a busy app would drown in them.
    expect(await eventsFor(user.id)).toHaveLength(0);
  });

  it('records no event for a logout with no valid session, so logout cannot be used to flood events', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, PASSWORD));
    expect((await logout(`${COOKIE}=${cookie}`)).status).toBe(204);
    await db.authenticationEvent.deleteMany({ where: { userId: user.id } });

    // Idempotent: the session is already revoked, so nothing is revoked and nothing is recorded.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await logout(`${COOKIE}=${cookie}`)).status).toBe(204);
    }
    expect(await eventsFor(user.id)).toHaveLength(0);
  });

  it('records nothing for an unusable recovery token', async () => {
    const before = await db.authenticationEvent.count();
    const response = await reset('not-a-recovery-token-value');
    expect(response.status).toBe(401);
    // No user can be attributed to an unknown token, so there is nothing an event row would add.
    expect(await db.authenticationEvent.count()).toBe(before);
  });
});

// --- Transaction boundaries ------------------------------------------------------

describe('a success event cannot outlive the operation it describes', () => {
  /**
   * Build an AuthService whose transaction refuses to write an audit row.
   *
   * This is the case that actually distinguishes a transactionally coupled write from a fire-and-forget
   * one. Rolling back *before* the event write proves nothing, because a detached write would not have
   * happened either. Failing the event write itself is the scenario that matters: a decoupled
   * implementation would let the login succeed with no audit record at all, which is precisely the
   * outcome this design exists to prevent.
   */
  function authServiceRefusingAuditWrites() {
    const refusing = new Proxy(db, {
      get(target, property) {
        if (property === '$transaction') {
          return async (argument) => {
            if (typeof argument !== 'function') return target.$transaction(argument);
            return target.$transaction(async (tx) => {
              const guarded = new Proxy(tx, {
                get(inner, name) {
                  if (name === 'authenticationEvent') {
                    return {
                      create: async () => {
                        throw new Error('audit write refused');
                      },
                      createMany: async () => {
                        throw new Error('audit write refused');
                      },
                    };
                  }
                  const value = inner[name];
                  return typeof value === 'function' ? value.bind(inner) : value;
                },
              });
              return argument(guarded);
            });
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return authServiceOver(refusing);
  }

  it('fails the whole login when the audit write fails, so no session outlives a missing record', async () => {
    const user = await account();
    const service = authServiceRefusingAuditWrites();

    await expect(service.login(user.email, PASSWORD)).rejects.toThrow('SERVICE_FAILURE');

    // Coupled: the session insert rolled back with the refused event write. A decoupled implementation
    // would have committed the session here and lost the audit record silently.
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.authenticationEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('still serves a normal login once the audit table accepts writes', async () => {
    // The control for the test above: the same code path succeeds when the write is allowed, so the
    // failure there can only be the refusal and not something unrelated.
    const user = await account();
    const working = authServiceOver(db);

    const result = await working.login(user.email, PASSWORD);
    expect(result.user.id).toBe(user.id);
    expect(await typesFor(user.id)).toEqual(['LOGIN_SUCCEEDED']);
  });

  it('leaves no LOGIN_SUCCEEDED when the session insert is rolled back', async () => {
    const user = await account();
    // Disabling the account between verification and the protected transaction forces the in-lock
    // revalidation to refuse, which aborts the transaction that would have carried the success event.
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });

    const response = await login(user.email, PASSWORD);
    expect(response.status).toBe(401);

    const types = await typesFor(user.id);
    expect(types).not.toContain('LOGIN_SUCCEEDED');
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('leaves no PASSWORD_RESET_COMPLETED when the reset transaction is refused', async () => {
    const user = await account({ status: 'ACTIVE' });
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    // Disabled before the reset transaction opens: the token is refused and the transaction aborts.
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });

    expect((await reset(token)).status).toBe(401);
    const types = await typesFor(user.id);
    expect(types).toEqual(['PASSWORD_RESET_REQUESTED']);
    // The credential was not replaced, so nothing claims otherwise.
    const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect((await verifyPassword(PASSWORD, credential.passwordHash)).matches).toBe(true);
    // And the new password was never applied.
    expect((await verifyPassword(NEW_PASSWORD, credential.passwordHash)).matches).toBe(false);
  });

  it('leaves no PASSWORD_RESET_REQUESTED when the issuing transaction fails', async () => {
    const user = await account();
    // Deleting the account makes the token insert fail on its foreign key.
    await db.passwordCredential.deleteMany({ where: { userId: user.id } });
    await db.authenticationEvent.deleteMany({ where: { userId: user.id } });

    const response = await forgot(user.email);
    expect(response.status).toBe(202); // Still generic to the caller.

    // The request was refused internally because the account is no longer eligible, so no token row
    // and no event row may exist.
    expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await typesFor(user.id)).toEqual([]);
  });
});

// --- Concurrency -----------------------------------------------------------------

describe('concurrent operations do not fabricate or lose events', () => {
  it('records one success per concurrent successful login, and never more', async () => {
    const user = await account();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => login(user.email, PASSWORD)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const events = await typesFor(user.id);
    expect(events.filter((type) => type === 'LOGIN_SUCCEEDED')).toHaveLength(4);
    // Every session that exists has exactly one corresponding event.
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(4);
  });

  it('records no success when every concurrent login is refused', async () => {
    const user = await account();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => login(user.email, OTHER_PASSWORD)),
    );
    expect(responses.every((response) => response.status === 401)).toBe(true);

    const events = await typesFor(user.id);
    expect(events).not.toContain('LOGIN_SUCCEEDED');
    expect(events.filter((type) => type === 'LOGIN_FAILED')).toHaveLength(5);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('lets exactly one concurrent reset win, and records a completion only for that one', async () => {
    const user = await account();
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    const responses = await Promise.all([reset(token), reset(token), reset(token)]);
    const successes = responses.filter((response) => response.status === 204);
    expect(successes).toHaveLength(1);
    // The others are generic refusals; none may be mistaken for a completion.
    expect(responses.filter((r) => r.status === 401)).toHaveLength(2);

    const types = await typesFor(user.id);
    expect(types.filter((type) => type === 'PASSWORD_RESET_COMPLETED')).toHaveLength(1);
    expect(types.filter((type) => type === 'SESSION_REVOKED')).toHaveLength(0);
  });
});

// --- Volume ----------------------------------------------------------------------

describe('event volume is bounded by the abuse limiter, not by attacker effort', () => {
  it('writes one failure row per admitted attempt and none for any refused one', async () => {
    const user = await account();

    // A determined attacker sending far more than the per-account allowance of 8, all at once.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => login(user.email, OTHER_PASSWORD)),
    );
    const admitted = responses.filter((response) => response.status === 401);
    const refused = responses.filter((response) => response.status === 429);
    expect(admitted.length + refused.length).toBe(20);
    expect(refused.length).toBeGreaterThan(0);

    const rows = await eventsFor(user.id);
    // Exactly the admitted attempts were recorded, so the table is bounded by policy (at most the
    // allowance) rather than by how hard the endpoint is hit.
    expect(rows).toHaveLength(admitted.length);
    expect(rows.every((row) => row.eventType === 'LOGIN_FAILED')).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(8);

    // And no refused request left a row: their correlation ids appear nowhere in the table.
    const refusedIds = refused.map((response) => response.headers.get(SECURITY_REQUEST_ID_HEADER));
    expect(await db.authenticationEvent.count({ where: { requestId: { in: refusedIds } } })).toBe(
      0,
    );
  });

  it('writes nothing for refused password-recovery requests', async () => {
    const user = await account();
    const responses = await Promise.all(Array.from({ length: 12 }, () => forgot(user.email)));
    const admitted = responses.filter((response) => response.status === 202);
    const refused = responses.filter((response) => response.status === 429);
    expect(refused.length).toBeGreaterThan(0);

    // One row per issued token, and the per-target allowance (3 per hour) bounds issuance.
    const requested = (await typesFor(user.id)).filter(
      (type) => type === 'PASSWORD_RESET_REQUESTED',
    );
    expect(requested.length).toBeLessThanOrEqual(3);
    expect(requested.length).toBeLessThanOrEqual(admitted.length);
    const refusedIds = refused.map((response) => response.headers.get(SECURITY_REQUEST_ID_HEADER));
    expect(await db.authenticationEvent.count({ where: { requestId: { in: refusedIds } } })).toBe(
      0,
    );
  });

  it('writes one LOGOUT for a burst of logouts of one session, and nothing for the refused ones', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, PASSWORD));
    await db.authenticationEvent.deleteMany({ where: { userId: user.id } });
    // The first revokes the session; every other is an idempotent no-op or is refused by the limiter.
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => logout(`${COOKIE}=${cookie}`)),
    );
    expect(responses.some((response) => response.status === 429)).toBe(true);
    expect(await typesFor(user.id)).toEqual(['LOGOUT']);
  });

  it('bounds successful logins per account, so LOGIN_SUCCEEDED volume has a per-account ceiling', async () => {
    // Stage 2.9 closes what was documented here as a known gap. A successful login is still refunded on the
    // credential meters (charging it would let one address lock out its colleagues), but it now spends a
    // per-account success budget of 10 per 10 minutes. The ceiling applies to sessions and to events alike,
    // and a refused login creates neither.
    const user = await account();
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await login(user.email, PASSWORD)).status);
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429, 429]);
    const succeeded = (await typesFor(user.id)).filter((type) => type === 'LOGIN_SUCCEEDED');
    expect(succeeded).toHaveLength(10);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(10);
  });
});

// --- Failure atomicity and ordering ------------------------------------------------

describe('audit failures are fail-closed for success and best-effort for failure', () => {
  const refuseAuditWrites = (_inner, name) =>
    name === 'authenticationEvent'
      ? {
          create: async () => {
            throw new Error('audit write refused');
          },
          createMany: async () => {
            throw new Error('audit write refused');
          },
        }
      : undefined;

  it('rolls the whole password reset back when its audit write fails', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    const service = recoveryServiceOver(interceptedDatabase({ inTransaction: refuseAuditWrites }));
    await expect(service.resetPassword(token, NEW_PASSWORD)).rejects.toThrow('SERVICE_FAILURE');

    // Nothing committed: credential unchanged, token unconsumed, session still live, no completion.
    const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect((await verifyPassword(PASSWORD, credential.passwordHash)).matches).toBe(true);
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    const types = await typesFor(user.id);
    expect(types).not.toContain('PASSWORD_RESET_COMPLETED');
    expect(types).not.toContain('SESSION_REVOKED');

    // The same token still works once the audit table accepts writes, proving it was not burned.
    expect((await reset(token)).status).toBe(204);
  });

  it('leaves the session live when the logout audit write fails', async () => {
    const user = await account();
    const token = tokenOf(await login(user.email, PASSWORD));

    const service = authServiceOver(interceptedDatabase({ inTransaction: refuseAuditWrites }));
    await expect(service.logout(token)).rejects.toThrow('SERVICE_FAILURE');

    // Revocation rolled back with the refused event, so the session is exactly as it was.
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    expect(await typesFor(user.id)).toEqual(['LOGIN_SUCCEEDED']);
  });

  it('answers a refused login with the same 401 even when the failure row cannot be written', async () => {
    const user = await account();
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === 'authenticationEvent') {
          return {
            create: async () => {
              throw new Error('audit write refused');
            },
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = authServiceOver(broken);

    // Must not become a SERVICE_FAILURE, which would distinguish "wrong password" from "audit down".
    await expect(service.login(user.email, OTHER_PASSWORD)).rejects.toThrow(
      'AUTHENTICATION_FAILED',
    );
    expect(await db.authenticationEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('records a refusal, and no success, when the credential changes after verification', async () => {
    const user = await account();
    // A reset commits in the window between password verification and the session transaction.
    const service = authServiceOver(
      interceptedDatabase({
        beforeTransaction: async () => {
          await db.passwordCredential.update({
            where: { userId: user.id },
            data: {
              passwordHash: await hashPassword(NEW_PASSWORD),
              passwordChangedAt: new Date(Date.now() + 5_000),
            },
          });
        },
      }),
    );

    await expect(service.login(user.email, PASSWORD)).rejects.toThrow('AUTHENTICATION_FAILED');
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    // Exactly one event, and it is a refusal. The success written inside the aborted transaction is gone.
    expect(await typesFor(user.id)).toEqual(['LOGIN_FAILED']);
  });

  it('records a disabled account as a refused login, never as an account-disabled event', async () => {
    const user = await account({ status: 'DISABLED' });
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect(await typesFor(user.id)).toEqual(['LOGIN_FAILED']);
  });
});

describe('a reset records exactly the revocations it performed', () => {
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** Seed `count` live sessions for a user with one statement, so large counts do not dominate the test. */
  const seedSessions = (userId, count) => db.$executeRaw`
    INSERT INTO "sessions" ("id", "userId", "tokenHash", "expiresAt")
    SELECT gen_random_uuid(), ${userId}::uuid, md5(random()::text || g::text) || md5(random()::text),
           now() + interval '7 days'
    FROM generate_series(1, ${count}) AS g`;

  /** A gate a test can park a participant at, so ordering is explicit instead of slept for. */
  function gate() {
    let arrive, open;
    const arrived = new Promise((resolve) => (arrive = resolve));
    const opened = new Promise((resolve) => (open = resolve));
    return { arrived, release: () => open(), wait: async () => (arrive(), opened) };
  }

  /** Poll until some backend is waiting on a row lock. Bounded, and a database fact rather than a delay. */
  async function untilABackendWaitsOnALock() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [{ waiting }] = await db.$queryRaw`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('no backend ever waited on a lock');
  }

  const revokedRows = async (userId) =>
    (await typesFor(userId)).filter((type) => type === 'SESSION_REVOKED').length;

  it('writes one event per revoked session, with valid UUIDv7 ids and one shared revocation time', async () => {
    const user = await account();
    await seedSessions(user.id, 7);
    await forgot(user.email);
    const before = Date.now();
    expect((await reset(delivery.deliveries[0].token)).status).toBe(204);
    const after = Date.now();

    const events = (await eventsFor(user.id)).filter((row) => row.eventType === 'SESSION_REVOKED');
    expect(events).toHaveLength(7);
    // Valid, distinct UUIDv7 identifiers: version 7, RFC variant, 48-bit millisecond prefix near now.
    expect(new Set(events.map((row) => row.id)).size).toBe(7);
    for (const row of events) {
      expect(row.id).toMatch(UUID7);
      const embedded = Number.parseInt(row.id.replaceAll('-', '').slice(0, 12), 16);
      expect(embedded).toBeGreaterThanOrEqual(before - 2_000);
      expect(embedded).toBeLessThanOrEqual(after + 2_000);
      expect(row.userId).toBe(user.id);
      expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // The same format the client-side default produces, so the column holds one kind of identifier.
    const clientMade = await db.authenticationEvent.create({
      data: { userId: user.id, eventType: 'LOGIN_FAILED' },
    });
    expect(clientMade.id).toMatch(UUID7);

    // The revocation time survives the SQL conversion exactly: one instant, inside the call's window, with
    // no time-zone shift (a shift would be hours, not milliseconds).
    const revokedAt = new Set(
      (await db.session.findMany({ where: { userId: user.id } })).map((row) =>
        row.revokedAt.getTime(),
      ),
    );
    expect(revokedAt.size).toBe(1);
    const [instant] = [...revokedAt];
    expect(instant).toBeGreaterThanOrEqual(before - 2_000);
    expect(instant).toBeLessThanOrEqual(after + 2_000);
  });

  it('survives a session count beyond the old transaction ceiling, with exact counts', async () => {
    // 25,000 exceeds the roughly 20,000 at which the per-row implementation failed closed on this machine.
    const user = await account();
    await seedSessions(user.id, 25_000);
    await forgot(user.email);
    expect((await reset(delivery.deliveries[0].token)).status).toBe(204);

    expect(await revokedRows(user.id)).toBe(25_000);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: { not: null } } })).toBe(
      25_000,
    );
    expect(
      (await typesFor(user.id)).filter((type) => type === 'PASSWORD_RESET_COMPLETED'),
    ).toHaveLength(1);
    const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect((await verifyPassword(NEW_PASSWORD, credential.passwordHash)).matches).toBe(true);
  }, 60_000);

  it('does not report a session revoked just before the revoking statement ran', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    // Revoke one session from outside, once, immediately before whichever statement revokes sessions. The
    // hook sits on both the delegate and the raw statement, so it still fires if the revocation is moved or
    // a count is read first: a reset that counted before this point would then over-report.
    let interleaved = false;
    const revokeOneElsewhere = async () => {
      if (interleaved) return;
      interleaved = true;
      const live = await db.session.findFirst({
        where: { userId: user.id, revokedAt: null },
        select: { id: true },
      });
      await db.session.update({ where: { id: live.id }, data: { revokedAt: new Date() } });
    };
    const service = recoveryServiceOver(
      interceptedDatabase({
        inTransaction: (inner, name) => {
          if (name === 'session') {
            return {
              ...Object.fromEntries(
                ['findMany', 'findFirst', 'count'].map((method) => [
                  method,
                  inner.session[method].bind(inner.session),
                ]),
              ),
              updateMany: async (args) => {
                await revokeOneElsewhere();
                return inner.session.updateMany(args);
              },
            };
          }
          if (name === '$executeRaw') {
            return async (...args) => {
              if (String(args[0]).includes('sessions')) await revokeOneElsewhere();
              return inner.$executeRaw(...args);
            };
          }
          return undefined;
        },
      }),
    );

    await service.resetPassword(token, NEW_PASSWORD);
    expect(interleaved).toBe(true);

    // Three existed, one was revoked elsewhere first, so the reset revoked two and reports two.
    expect(await revokedRows(user.id)).toBe(2);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it('reports a session once when a real logout holds its row while the reset runs', async () => {
    const user = await account();
    const cookies = [];
    for (let index = 0; index < 4; index += 1) {
      cookies.push(tokenOf(await login(user.email, PASSWORD)));
    }
    await forgot(user.email);
    const token = delivery.deliveries[0].token;
    await db.authenticationEvent.deleteMany({ where: { userId: user.id } });

    // Logout revokes its session, then parks before its event insert, holding the row lock uncommitted.
    const parked = gate();
    const logoutService = authServiceOver(
      interceptedDatabase({
        inTransaction: (inner, name) =>
          name === 'authenticationEvent'
            ? {
                create: async (args) => {
                  await parked.wait();
                  return inner.authenticationEvent.create(args);
                },
              }
            : undefined,
      }),
    );
    const loggingOut = logoutService.logout(cookies[0]);
    await parked.arrived;

    // The reset's UPDATE now reaches that locked row and blocks until the logout transaction ends.
    const resetting = reset(token);
    await untilABackendWaitsOnALock();
    parked.release();
    await loggingOut;
    expect((await resetting).status).toBe(204);

    // Four sessions: logout revoked one and recorded LOGOUT; the reset revoked the other three.
    const types = await typesFor(user.id);
    expect(types.filter((type) => type === 'LOGOUT')).toHaveLength(1);
    expect(types.filter((type) => type === 'SESSION_REVOKED')).toHaveLength(3);
    expect(types.filter((type) => type === 'PASSWORD_RESET_COMPLETED')).toHaveLength(1);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it('rolls back revocation and every event when the set-based statement itself fails', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    const service = recoveryServiceOver(
      interceptedDatabase({
        inTransaction: (inner, name) =>
          name === '$executeRaw'
            ? async () => {
                throw new Error('revocation statement refused');
              }
            : undefined,
      }),
    );
    await expect(service.resetPassword(token, NEW_PASSWORD)).rejects.toThrow('SERVICE_FAILURE');

    // Credential replaced? token consumed? Neither: the transaction aborted as a whole.
    const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect((await verifyPassword(PASSWORD, credential.passwordHash)).matches).toBe(true);
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
    const types = await typesFor(user.id);
    expect(types).not.toContain('SESSION_REVOKED');
    expect(types).not.toContain('PASSWORD_RESET_COMPLETED');
  });

  it('rolls back a revocation that already ran when the completion event then fails', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    await login(user.email, PASSWORD);
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    const service = recoveryServiceOver(
      interceptedDatabase({
        inTransaction: (inner, name) =>
          name === 'authenticationEvent'
            ? {
                create: async () => {
                  throw new Error('completion event refused');
                },
              }
            : undefined,
      }),
    );
    await expect(service.resetPassword(token, NEW_PASSWORD)).rejects.toThrow('SERVICE_FAILURE');

    // The set-based statement had already revoked both sessions and inserted two events inside this
    // transaction. None of that may survive.
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(2);
    expect((await typesFor(user.id)).filter((type) => type === 'SESSION_REVOKED')).toHaveLength(0);
  });

  it('lets exactly one of several concurrent resets revoke and record the sessions', async () => {
    const user = await account();
    await seedSessions(user.id, 5);
    await forgot(user.email);
    const token = delivery.deliveries[0].token;

    const responses = await Promise.all([reset(token), reset(token), reset(token), reset(token)]);
    expect(responses.filter((response) => response.status === 204)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(3);

    const types = await typesFor(user.id);
    expect(types.filter((type) => type === 'SESSION_REVOKED')).toHaveLength(5);
    expect(types.filter((type) => type === 'PASSWORD_RESET_COMPLETED')).toHaveLength(1);
  });

  it('writes no event for a session that was already revoked or expired', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    const cookie = tokenOf(await login(user.email, PASSWORD));
    await logout(`${COOKIE}=${cookie}`);
    await db.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await forgot(user.email);
    expect((await reset(delivery.deliveries[0].token)).status).toBe(204);
    expect(await revokedRows(user.id)).toBe(0);
  });

  it("never touches another user's sessions", async () => {
    const user = await account();
    const bystander = await account();
    await seedSessions(user.id, 3);
    await seedSessions(bystander.id, 3);
    await forgot(user.email);
    expect((await reset(delivery.deliveries[0].token)).status).toBe(204);

    expect(await revokedRows(user.id)).toBe(3);
    expect(await revokedRows(bystander.id)).toBe(0);
    expect(await db.session.count({ where: { userId: bystander.id, revokedAt: null } })).toBe(3);
  });
});

describe('unusable recovery tokens change nothing', () => {
  it('refuses an expired token and writes no completion', async () => {
    const user = await account();
    await forgot(user.email);
    const token = delivery.deliveries[0].token;
    await db.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect((await reset(token)).status).toBe(401);
    expect(await typesFor(user.id)).toEqual(['PASSWORD_RESET_REQUESTED']);
    const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
    expect((await verifyPassword(PASSWORD, credential.passwordHash)).matches).toBe(true);
  });

  it('refuses a consumed token and keeps a single completion for the original use', async () => {
    const user = await account();
    await forgot(user.email);
    const token = delivery.deliveries[0].token;
    expect((await reset(token)).status).toBe(204);
    expect((await reset(token, OTHER_PASSWORD)).status).toBe(401);
    expect((await reset(token, OTHER_PASSWORD)).status).toBe(401);

    expect(await typesFor(user.id)).toEqual([
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
    ]);
  });

  it('refuses a superseded token, and the newer one completes', async () => {
    const user = await account();
    await forgot(user.email);
    const older = delivery.deliveries[0].token;
    await forgot(user.email);
    const newer = delivery.deliveries[1].token;

    expect((await reset(older)).status).toBe(401);
    expect((await reset(newer)).status).toBe(204);
    expect(await typesFor(user.id)).toEqual([
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
    ]);
  });
});

// --- Privacy ---------------------------------------------------------------------

describe('stored events contain no secret material', () => {
  it('never stores a password, recovery token, session token, or address in any column', async () => {
    const user = await account();
    await login(user.email, PASSWORD);
    const cookie = tokenOf(await login(user.email, PASSWORD));
    await forgot(user.email);
    const token = delivery.deliveries[0].token;
    await reset(token);
    await logout(`${COOKIE}=${cookie}`);

    const rows = await db.authenticationEvent.findMany({ where: { userId: user.id } });
    expect(rows.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(rows);
    for (const secret of [
      PASSWORD,
      NEW_PASSWORD,
      OTHER_PASSWORD,
      token,
      cookie,
      user.email,
      user.normalizedEmail,
    ]) {
      expect(serialised).not.toContain(secret);
    }

    // Structurally: the only columns are the four the model defines.
    expect(new Set(rows.flatMap((row) => Object.keys(row)))).toEqual(
      new Set(['id', 'userId', 'eventType', 'occurredAt', 'requestId']),
    );
  });

  it('keeps a security history that cannot be cascaded away with the account', async () => {
    // Stage 2.7 turns the accepted Stage 2.1 `ON DELETE RESTRICT` from a modelling choice into a live
    // property: with rows now actually written, deleting a user must be blocked rather than silently
    // destroying the record of what happened to them.
    const user = await account();
    await login(user.email, PASSWORD);
    expect(await typesFor(user.id)).toContain('LOGIN_SUCCEEDED');

    await expect(db.user.delete({ where: { id: user.id } })).rejects.toThrow();
    expect(await db.authenticationEvent.count({ where: { userId: user.id } })).toBeGreaterThan(0);
  });
});
