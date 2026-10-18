import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis, createRedisClient } from '@tsms/redis';
import { PASSWORD, createHarness } from './support/stage210-harness.mjs';
import { admissionFor, successMeterFor } from './support/stage29-wiring.mjs';
import { AuthService } from '../dist/identity/auth.service.js';
import { PasswordRecoveryService } from '../dist/identity/password-recovery.service.js';
import { InMemoryRecoveryDelivery } from '../dist/identity/password-recovery-delivery.js';
import { SecurityEventRecorder } from '../dist/identity/security-event-recorder.js';
import { SecurityLog } from '../dist/identity/security-log.js';
import { SessionService } from '../dist/identity/session.service.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
} from '../dist/identity/password-recovery-token.js';

/**
 * Stage 2.10.1 CON-03 (deterministic part): the per-user session-mutation lock is what orders a login and a reset.
 *
 * Why this file exists. A negative control found that REMOVING the advisory lock (`lockUserSessionMutations`) was not
 * detected by any test: not the accepted 27-test race suite, which parks a login BEFORE it takes the lock, and not the
 * randomized mixed-concurrency round in stage210-concurrency, which only sometimes lands inside the critical section.
 * Without the lock the login's revalidation and its session insert are separate statements that a committing reset can
 * land between, leaving a live session authenticated with a password that no longer exists.
 *
 * These tests park one participant INSIDE its critical section (lock held, transaction open) and then start the other,
 * so the interleaving is forced, not hoped for. Nothing depends on timing: the parked side waits on an explicit gate, and
 * "the other side is blocked on the lock" is observed in `pg_locks`, not assumed from a sleep.
 *
 * Every test is an INVARIANT.
 */

const OLD_PASSWORD = PASSWORD;
const NEW_PASSWORD = 'a brand new password value';
const RECOVERY_BASE = 'https://app.example.test/account/recover';

const h = createHarness({ secret: 'stage210_lock_suite_rate_limit_key_0123456789abcdefg' });
let redis;
let securityLog;
let realEvents;

beforeAll(async () => {
  await h.start();
  redis = createRedisClient(h.env.TEST_REDIS_URL);
  securityLog = new SecurityLog({ sink: () => undefined });
  realEvents = new SecurityEventRecorder(h.db, securityLog);
});
afterAll(async () => {
  if (redis) await closeRedis(redis);
  await h.stop();
});
beforeEach(() => h.resetState());
afterEach(() => h.cleanup());

/** A one-shot latch. `arrived` settles when the parked participant reaches the gate. */
function gate() {
  let signalArrival;
  let open;
  const arrived = new Promise((resolve) => (signalArrival = resolve));
  const released = new Promise((resolve) => (open = resolve));
  return { arrived, release: () => open(), wait: () => released, signal: () => signalArrival() };
}

/** A login whose session insert is parked: lock taken, credential revalidated, session not yet created. */
function authParkedInsideTransaction(control) {
  class ParkedSessions extends SessionService {
    async createSessionInTransaction(tx, userId) {
      control.signal();
      await control.wait();
      return super.createSessionInTransaction(tx, userId);
    }
  }
  return new AuthService(
    h.db,
    new ParkedSessions(h.db),
    admissionFor(redis),
    realEvents,
    securityLog,
    successMeterFor(redis),
  );
}

const plainAuth = () =>
  new AuthService(
    h.db,
    new SessionService(h.db),
    admissionFor(redis),
    realEvents,
    securityLog,
    successMeterFor(redis),
  );

function recoveryService(events = realEvents) {
  return new PasswordRecoveryService(
    h.db,
    new InMemoryRecoveryDelivery(),
    { mode: 'development-only', urlBase: RECOVERY_BASE },
    admissionFor(redis),
    events,
    securityLog,
  );
}

/** A reset whose completion is parked: lock held, sessions already revoked, transaction not yet committed. */
function recoveryParkedBeforeCommit(control) {
  const parked = Object.create(realEvents);
  parked.inTransaction = async (tx, input) => {
    if (input.eventType === 'PASSWORD_RESET_COMPLETED') {
      control.signal();
      await control.wait();
    }
    return realEvents.inTransaction(tx, input);
  };
  return recoveryService(parked);
}

async function issueToken(user) {
  const token = generateRecoveryToken();
  await h.db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRecoveryToken(token),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return token;
}

const advisoryWaiters = async () => {
  const [{ waiting }] = await h.db.$queryRaw`
    SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
  return waiting;
};

/**
 * Wait until the other participant is either blocked on the advisory lock or has finished. Returns which, so the test
 * can assert that it was BLOCKED. Bounded; a participant that does neither is a hang and fails loudly.
 */
async function blockedOrFinished(finished, limitMillis = 20_000) {
  let done = false;
  void finished.then(
    () => (done = true),
    () => (done = true),
  );
  const deadline = Date.now() + limitMillis;
  for (;;) {
    if ((await advisoryWaiters()) > 0) return 'blocked';
    if (done) return 'finished';
    if (Date.now() > deadline)
      throw new Error('the participant neither blocked on the lock nor finished');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('CON-03 the per-user lock orders a login and a reset', () => {
  it('INVARIANT: a reset that starts while a login is inside its critical section waits for it, then revokes the session it created', async () => {
    const user = await h.account({ password: OLD_PASSWORD });
    const token = await issueToken(user);
    const parked = gate();

    const login = authParkedInsideTransaction(parked).login(user.email, OLD_PASSWORD);
    await parked.arrived; // the login holds the lock and has revalidated the old credential

    const reset = recoveryService().resetPassword(token, NEW_PASSWORD);
    const state = await blockedOrFinished(reset);
    expect(state, 'the reset must wait for the login rather than commit in the middle of it').toBe(
      'blocked',
    );

    parked.release();
    const [loginResult] = await Promise.all([login, reset]);

    // The login finished first and was authenticated by a password that was then replaced, so its session must not survive.
    expect(loginResult.token).toBeDefined();
    expect(await h.liveSessions(user.id)).toBe(0);
    expect(await h.events(user.id, 'LOGIN_SUCCEEDED')).toBe(1);
    expect(await h.events(user.id, 'SESSION_REVOKED')).toBe(1);
    expect(await h.events(user.id, 'PASSWORD_RESET_COMPLETED')).toBe(1);
    expect((await h.login(user.email, OLD_PASSWORD)).status).toBe(401);
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  }, 60_000);

  it('INVARIANT: a login that starts while a reset is inside its critical section waits for it, then is refused', async () => {
    const user = await h.account({ password: OLD_PASSWORD });
    const token = await issueToken(user);
    const parked = gate();

    const reset = recoveryParkedBeforeCommit(parked).resetPassword(token, NEW_PASSWORD);
    await parked.arrived; // the reset holds the lock; sessions revoked; the new credential is written but uncommitted

    const login = plainAuth()
      .login(user.email, OLD_PASSWORD)
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    const state = await blockedOrFinished(login);
    expect(state, 'the login must wait for the reset rather than insert a session beside it').toBe(
      'blocked',
    );

    parked.release();
    await reset;
    const outcome = await login;

    // The old password was verified before the reset committed, but the in-lock revalidation sees the new credential.
    expect(outcome.error?.code).toBe('AUTHENTICATION_FAILED');
    expect(await h.liveSessions(user.id)).toBe(0);
    expect(await h.events(user.id, 'LOGIN_SUCCEEDED')).toBe(0);
    expect(await h.events(user.id, 'PASSWORD_RESET_COMPLETED')).toBe(1);
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  }, 60_000);
});
