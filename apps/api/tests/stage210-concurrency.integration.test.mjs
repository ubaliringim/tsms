import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, createHarness, tokenFrom } from './support/stage210-harness.mjs';

/**
 * Stage 2.10.1 CON-03: mixed authentication and recovery concurrency.
 *
 * The accepted race suites exercise pairs (login vs reset, issuance vs reset, logout vs revoke). This suite fires the
 * whole set at one account at the same moment - a password reset, several logins with the OLD password, a logout of
 * an existing session, a second recovery request, and a session lookup - and then checks the invariants that must hold
 * however the database orders them. It does not assert which request wins, because that is not defined; it asserts
 * what no ordering may violate.
 *
 * Every test here is an INVARIANT. Nothing in this file characterizes a known weakness.
 */

const OLD_PASSWORD = PASSWORD;
const NEW_PASSWORD = 'a brand new password value';
const LOGINS = 6;
const ROUNDS = 3;

const h = createHarness({
  secret: 'stage210_concurrency_rate_limit_key_0123456789abcdef',
  recovery: true,
});

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.resetState());
afterEach(() => h.cleanup());

/** Fail loudly instead of hanging if the round deadlocks. */
function withDeadline(promise, millis, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${millis} ms`)),
      millis,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function liveRecoveryTokens(userId) {
  return h.db.passwordResetToken.count({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
  });
}

describe('CON-03 mixed authentication and recovery concurrency', () => {
  it.each(Array.from({ length: ROUNDS }, (_, index) => [index + 1]))(
    'INVARIANT (round %i): a reset, old-password logins, a logout, a second recovery request and a lookup leave one consistent state',
    async () => {
      const user = await h.account({ password: OLD_PASSWORD });
      const existing = tokenFrom(await h.login(user.email, OLD_PASSWORD));
      expect(existing).toBeDefined();

      h.delivery.clear();
      expect((await h.forgot(user.email)).status).toBe(202);
      const recoveryToken = h.delivery.last.token;

      const calls = {
        reset: h.resetPassword(recoveryToken, NEW_PASSWORD),
        logins: Array.from({ length: LOGINS }, () => h.login(user.email, OLD_PASSWORD)),
        logout: h.logout(existing),
        forgot: h.forgot(user.email),
        lookup: h.me(existing),
      };
      const settled = await withDeadline(
        Promise.all([
          calls.reset,
          Promise.all(calls.logins),
          calls.logout,
          calls.forgot,
          calls.lookup,
        ]),
        45_000,
        'the concurrent round',
      );
      const [reset, logins, logout, forgot, lookup] = settled;

      // 1. Only statuses the contract allows. No server error, no rate-limit refusal, no saturation.
      expect([204, 401], 'reset').toContain(reset.status); // 401: the second recovery request superseded its token
      for (const response of logins) expect([200, 401]).toContain(response.status);
      expect(logout.status).toBe(204);
      expect(forgot.status).toBe(202);
      expect([200, 401]).toContain(lookup.status);

      const resetSucceeded = reset.status === 204;
      const succeededLogins = logins.filter((response) => response.status === 200).length;

      // 2. A session created with a password that was replaced cannot survive the replacement. When the reset won,
      //    every old-password session was either created before it (and revoked by it) or refused after it.
      const live = await h.liveSessions(user.id);
      if (resetSucceeded) {
        expect(live).toBe(0);
      } else {
        // The password did not change, so each successful login owns a live session, and the pre-existing one was
        // revoked by the logout.
        expect(live).toBe(succeededLogins);
      }

      // 3. Sessions and their events agree exactly, however the requests interleaved.
      const sessions = await h.db.session.count({ where: { userId: user.id } });
      expect(sessions).toBe(1 + succeededLogins);
      expect(await h.events(user.id, 'LOGIN_SUCCEEDED')).toBe(sessions);
      const revoked = await h.db.session.count({
        where: { userId: user.id, revokedAt: { not: null } },
      });
      expect(
        (await h.events(user.id, 'LOGOUT')) + (await h.events(user.id, 'SESSION_REVOKED')),
        'every revoked session is explained by exactly one event',
      ).toBe(revoked);

      // 4. The reset event exists if and only if the reset succeeded.
      expect(await h.events(user.id, 'PASSWORD_RESET_COMPLETED')).toBe(resetSucceeded ? 1 : 0);

      // 5. At most one recovery token is live (the issuance lock), and the credential matches the reset outcome.
      expect(await liveRecoveryTokens(user.id)).toBeLessThanOrEqual(1);
      const newWorks = (await h.login(user.email, NEW_PASSWORD)).status === 200;
      const oldWorks = (await h.login(user.email, OLD_PASSWORD)).status === 200;
      expect(newWorks).toBe(resetSucceeded);
      expect(oldWorks).toBe(!resetSucceeded);
    },
    90_000,
  );

  it('INVARIANT: the same round on two accounts at once keeps the accounts independent', async () => {
    const [first, second] = [
      await h.account({ password: OLD_PASSWORD }),
      await h.account({ password: OLD_PASSWORD }),
    ];
    const tokens = [];
    for (const user of [first, second]) {
      h.delivery.clear();
      expect((await h.forgot(user.email)).status).toBe(202);
      tokens.push(h.delivery.last.token);
    }
    const [resetFirst, loginSecond] = await withDeadline(
      Promise.all([
        h.resetPassword(tokens[0], NEW_PASSWORD),
        Promise.all(Array.from({ length: 4 }, () => h.login(second.email, OLD_PASSWORD))),
      ]),
      45_000,
      'the two-account round',
    );
    expect(resetFirst.status).toBe(204);
    // The other account's logins are unaffected by the first account's reset.
    for (const response of loginSecond) expect(response.status).toBe(200);
    expect(await h.liveSessions(second.id)).toBe(4);
    expect(await h.events(second.id, 'PASSWORD_RESET_COMPLETED')).toBe(0);
    expect(await h.events(second.id, 'SESSION_REVOKED')).toBe(0);
    expect(await h.liveSessions(first.id)).toBe(0);
  }, 90_000);
});
