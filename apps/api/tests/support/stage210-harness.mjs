// Shared harness for the Stage 2.10.1 regression and characterization suites.
//
// It follows the conventions of the accepted integration suites: a real application on a real PostgreSQL and Redis,
// fixtures created through the database client and removed by id, the rate-limit namespace reset before each test,
// and every in-flight request settled before a row is deleted.
//
// Two rules that matter for the suites that use it:
//
// - It never deletes by anything but the ids of the fixture users that THIS suite created. In particular it does not
//   call `clearOrphanSecurityEvents`, which deletes every event with no user. The Stage 2.10.1 suites never submit an
//   address that matches no account, so they create no such rows and have nothing of that kind to remove.
// - It refuses to run unless the database is the disposable test database (`assertDisposableTestDatabase`) and the
//   Redis URL is the guarded test Redis (`parseIntegrationEnvironment`).

import { randomUUID } from 'node:crypto';
import { parseIntegrationEnvironment } from '@tsms/config';
import { closeDatabase, createDatabaseClient } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../../dist/application.js';
import { hashPassword } from '../../dist/identity/password-hasher.js';
import { RECOVERY_DELIVERY } from '../../dist/identity/auth.module.js';
import { resetRateLimitState } from './rate-limit-state.mjs';
import { settleRequests } from './track-requests.mjs';

export const TRUSTED_ORIGIN = 'http://127.0.0.1:3000';
export const COOKIE = 'tsms_session';
export const PASSWORD = 'correct horse battery staple';
export const WRONG_PASSWORD = 'entirely different secret phrase';
export const RECOVERY_BASE = 'https://app.example.test/account/recover';
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const integrationEnv = () => parseIntegrationEnvironment(process.env);

/** The Set-Cookie value for the session, or undefined. */
export function tokenFrom(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  const session = header.find((value) => value.startsWith(`${COOKIE}=`));
  return session?.slice(COOKIE.length + 1).split(';')[0];
}

export const cookieHeader = (token) => (token === undefined ? undefined : `${COOKIE}=${token}`);

export function createHarness({ secret, recovery = false }) {
  const env = integrationEnv();
  const state = { db: undefined, app: undefined, origin: undefined, delivery: undefined };
  let ids = [];

  const harness = {
    env,
    get db() {
      return state.db;
    },
    get app() {
      return state.app;
    },
    get origin() {
      return state.origin;
    },
    get delivery() {
      return state.delivery;
    },
    get ids() {
      return ids;
    },

    async start() {
      const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
      state.db = createDatabaseClient(databaseUrl);
      state.app = await createApplication({
        NODE_ENV: 'test',
        API_HOST: '127.0.0.1',
        API_PORT: 4000,
        DATABASE_URL: databaseUrl,
        REDIS_URL: env.TEST_REDIS_URL,
        API_TRUSTED_ORIGINS: [TRUSTED_ORIGIN],
        API_RATE_LIMIT_HMAC_SECRET: secret,
        ...(recovery
          ? {
              API_PASSWORD_RECOVERY_URL_BASE: RECOVERY_BASE,
              API_PASSWORD_RECOVERY_DELIVERY_MODE: 'development-only',
            }
          : {}),
      });
      if (recovery) state.delivery = state.app.get(RECOVERY_DELIVERY);
      await state.app.listen(0, '127.0.0.1');
      state.origin = await state.app.getUrl();
    },

    async stop() {
      await state.app?.close();
      if (state.db) await closeDatabase(state.db);
    },

    /** Each test starts with an empty rate-limit budget. The real limiter runs throughout. */
    async resetState() {
      await resetRateLimitState(env.TEST_REDIS_URL);
      ids = [];
      state.delivery?.clear();
    },

    /** Remove only this suite's own fixtures, children first, after in-flight requests have settled. */
    async cleanup() {
      await settleRequests();
      const { db } = state;
      if (!db) return;
      await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
      await db.session.deleteMany({ where: { userId: { in: ids } } });
      await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
      await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    },

    async account({ status = 'ACTIVE', password = PASSWORD, email } = {}) {
      const address = email ?? `${randomUUID()}@example.test`;
      const user = await state.db.user.create({
        data: {
          email: address,
          normalizedEmail: address.toLowerCase(),
          displayName: 'Synthetic Identity',
          status,
        },
      });
      ids.push(user.id);
      if (password !== null) {
        await state.db.passwordCredential.create({
          data: { userId: user.id, passwordHash: await hashPassword(password) },
        });
      }
      return user;
    },

    /** Minimal request helper. Cookie and Origin are set explicitly; there is no jar. */
    call(path, { method = 'GET', body, cookie, origin, headers = {}, raw } = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      if (payload !== undefined) {
        init.body = payload;
        init.headers['content-type'] = init.headers['content-type'] ?? 'application/json';
      }
      if (cookie !== undefined) init.headers['cookie'] = cookie;
      if (origin !== undefined) init.headers['origin'] = origin;
      return fetch(`${state.origin}${path}`, init);
    },

    login(email, password = PASSWORD, extra = {}) {
      return harness.call('/auth/login', {
        method: 'POST',
        body: { email, password },
        origin: TRUSTED_ORIGIN,
        ...extra,
      });
    },

    me(token) {
      return harness.call('/auth/me', { cookie: cookieHeader(token) });
    },

    logout(token) {
      return harness.call('/auth/logout', {
        method: 'POST',
        origin: TRUSTED_ORIGIN,
        cookie: cookieHeader(token),
      });
    },

    forgot(email) {
      return harness.call('/auth/password/forgot', {
        method: 'POST',
        body: { email },
        origin: TRUSTED_ORIGIN,
      });
    },

    resetPassword(token, newPassword) {
      return harness.call('/auth/password/reset', {
        method: 'POST',
        body: { token, newPassword },
        origin: TRUSTED_ORIGIN,
      });
    },

    /** Counts that belong to this test's own fixture users only. */
    liveSessions(userId) {
      return state.db.session.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
    },

    events(userId, eventType) {
      return state.db.authenticationEvent.count({
        where: { userId, ...(eventType === undefined ? {} : { eventType }) },
      });
    },
  };
  return harness;
}
