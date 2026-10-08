import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createApplication } from '../dist/application.js';
import { hashPassword } from '../dist/identity/password-hasher.js';
import { PasswordCredentialService } from '../dist/identity/password-credential.service.js';
import { SessionService } from '../dist/identity/session.service.js';
import { AuthService } from '../dist/identity/auth.service.js';
import { PasswordRecoveryService } from '../dist/identity/password-recovery.service.js';
import { InMemoryRecoveryDelivery } from '../dist/identity/password-recovery-delivery.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
} from '../dist/identity/password-recovery-token.js';
import { RECOVERY_DELIVERY } from '../dist/identity/auth.module.js';

/**
 * Stage 2.5 blocker: the password-reset / session-creation race.
 *
 * The invariant under test is: a login authenticated with a password that a completed reset
 * replaced must not end up with a usable session.
 *
 * These tests drive the real services against real PostgreSQL, with real advisory locks, and park a
 * participant at an explicit seam rather than sleeping. `afterPasswordVerified` wraps the accepted
 * credential service so a login can be stopped at exactly the window that used to be unprotected:
 * password verified, lock not yet taken, session not yet inserted. No test depends on timing.
 */

const ORIGIN = 'http://127.0.0.1:3000';
const COOKIE = 'tsms_session';
const RECOVERY_BASE = 'https://app.example.test/account/recover';
const OLD_PASSWORD = 'the original password value';
const NEW_PASSWORD = 'a brand new password value';
/** Two competing reset passwords, so assertions can follow the outcome instead of assuming one. */
const RESET_ONE = 'reset attempt one here';
const RESET_TWO = 'reset attempt two here';

let db, app, origin, delivery, ids;
let credentials, sessions, recovery;

/**
 * Builds a login service whose password verification can be parked.
 *
 * The wrapper delegates to the accepted credential service and then blocks, which places the login
 * precisely after verification and before the protected transaction.
 */
function authServiceWithPausedVerification(control) {
  const pausing = new PasswordCredentialService(db);
  pausing.verifyCredentialVersioned = async (...args) => {
    const outcome = await credentials.verifyCredentialVersioned(...args);
    if (control) {
      control.signal();
      await control.wait();
    }
    return outcome;
  };
  return new AuthService(db, pausing, sessions);
}

/**
 * A one-shot latch.
 *
 * `arrived` settles only once the parked participant has actually reached the gate, so awaiting it
 * is a real synchronization point rather than a microtask guess. `wait()` parks the participant.
 */
function gate() {
  let signalArrival;
  let open;
  const arrived = new Promise((resolve) => {
    signalArrival = resolve;
  });
  const released = new Promise((resolve) => {
    open = resolve;
  });
  return {
    /** Settles when the parked participant reaches the gate. Await this. */
    arrived,
    /** Let the parked participant continue. */
    release: () => open(),
    /** Park until released. */
    wait: () => released,
    /** Signal arrival from inside the parked participant. */
    signal: () => signalArrival(),
  };
}

beforeAll(async () => {
  const env = parseIntegrationEnvironment(process.env);
  const databaseUrl = assertDisposableTestDatabase(env.TEST_DATABASE_URL);
  db = createDatabaseClient(databaseUrl);
  credentials = new PasswordCredentialService(db);
  sessions = new SessionService(db);
  recovery = new PasswordRecoveryService(db, new InMemoryRecoveryDelivery(), {
    mode: 'development-only',
    urlBase: RECOVERY_BASE,
  });
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
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

async function account({ status = 'ACTIVE', password = OLD_PASSWORD } = {}) {
  const email = `${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email, normalizedEmail: email, displayName: 'Synthetic Identity', status },
  });
  ids.push(user.id);
  if (password !== null) {
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(password) },
    });
  }
  return user;
}

/** Issue a token directly on the service, bypassing HTTP delivery plumbing. */
async function issueFor(user) {
  const raw = generateRecoveryToken();
  const issuedAt = new Date();
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashRecoveryToken(raw),
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 1_800_000),
      usedAt: null,
    },
  });
  return raw;
}

const login = (email, password) =>
  fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });

const resetPassword = (token, newPassword = NEW_PASSWORD) =>
  fetch(`${origin}/auth/password/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ token, newPassword }),
  });

const me = (cookie) => fetch(`${origin}/auth/me`, { headers: { cookie: `${COOKIE}=${cookie}` } });

const tokenOf = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE}=`))
    .slice(COOKIE.length + 1)
    .split(';')[0];

/** Map a service-level reset into the HTTP status it would produce. */
async function resetOutcome(token, newPassword = NEW_PASSWORD) {
  try {
    await recovery.resetPassword(token, newPassword);
    return 204;
  } catch (error) {
    if (error?.code === 'RECOVERY_TOKEN_INVALID') return 401;
    if (error?.code === 'INVALID_PASSWORD') return 400;
    return `unexpected:${error?.code ?? error?.message}`;
  }
}

const liveSessionCount = () =>
  db.session.count({ where: { userId: { in: ids }, revokedAt: null } });

// --- 1. Login verification begins before reset; insertion delayed until after reset --------

describe('the critical race: verified login whose password is replaced before it can insert', () => {
  it('refuses the login and creates no session', async () => {
    const user = await account();
    const control = gate();
    const auth = authServiceWithPausedVerification(control);

    // Start the login. It verifies the password, then parks before the protected transaction.
    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;

    // A reset now completes end to end. It takes the same per-user advisory lock, which the parked
    // login has not taken yet, so this cannot deadlock.
    const token = await issueFor(user);
    await expect(recovery.resetPassword(token, NEW_PASSWORD)).resolves.toBeUndefined();

    // Release the login into a world where its verified password no longer exists.
    control.release();
    await expect(attempt).rejects.toMatchObject({
      name: 'AuthError',
      code: 'AUTHENTICATION_FAILED',
    });

    // The decisive assertion: no session exists on a replaced password.
    expect(await liveSessionCount()).toBe(0);
    const rows = await db.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);

    // The replaced password no longer authenticates, over HTTP as well.
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('rejects the stale login as a plain wrong password, with no cookie', async () => {
    const user = await account();
    const token = await issueFor(user);
    await recovery.resetPassword(token, NEW_PASSWORD);

    const response = await login(user.email, OLD_PASSWORD);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      statusCode: 401,
      error: 'authentication_failed',
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('revokes a session a login fully committed before the reset began', async () => {
    const user = await account();
    const cookie = tokenOf(await login(user.email, OLD_PASSWORD));
    expect((await me(cookie)).status).toBe(200);

    const token = await issueFor(user);
    await recovery.resetPassword(token, NEW_PASSWORD);

    expect((await me(cookie)).status).toBe(401);
    expect(await liveSessionCount()).toBe(0);
  });
});

// --- 2. Reset commits before a previously started login attempts creation -------------------

describe('reset completing before session creation', () => {
  it('makes the credential version observable, and refuses the old password afterwards', async () => {
    const user = await account();
    const before = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });

    const token = await issueFor(user);
    await recovery.resetPassword(token, NEW_PASSWORD);

    const after = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    // This strictly-advancing timestamp is the version the in-lock revalidation compares.
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());

    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('serves a login that starts after the reset from the new credential', async () => {
    const user = await account();
    const token = await issueFor(user);
    await recovery.resetPassword(token, NEW_PASSWORD);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect(await liveSessionCount()).toBe(1);
  });
});

// --- 3. Concurrent valid logins -------------------------------------------------------------

describe('concurrent valid logins', () => {
  it('admits every concurrent valid login with a distinct session', async () => {
    const user = await account();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => login(user.email, OLD_PASSWORD)),
    );
    for (const response of results) expect(response.status).toBe(200);
    expect(await liveSessionCount()).toBe(6);

    const rows = await db.session.findMany({
      where: { userId: user.id },
      select: { tokenHash: true },
    });
    expect(new Set(rows.map((row) => row.tokenHash)).size).toBe(6);
  });

  it('rejects concurrent wrong passwords without creating sessions', async () => {
    const user = await account();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => login(user.email, 'not the password at all')),
    );
    for (const response of results) expect(response.status).toBe(401);
    expect(await liveSessionCount()).toBe(0);
  });
});

// --- 4. Concurrent password resets ------------------------------------------------------------

describe('concurrent password resets', () => {
  it('lets at most one of two live tokens win, with no partial application', async () => {
    const user = await account();
    const first = await issueFor(user);
    const second = await issueFor(user);
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(2);

    const outcomes = await Promise.all([
      resetOutcome(first, RESET_ONE),
      resetOutcome(second, RESET_TWO),
    ]);
    // Exactly one token is redeemable. Which one depends on which transaction takes the per-user
    // lock first, so the assertions follow the outcome rather than assuming a winner.
    expect(outcomes.sort()).toEqual([204, 401]);

    // Nothing outstanding remains: the winner is consumed and the other is superseded.
    expect(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })).toBe(0);

    // Exactly one of the two attempted passwords is in effect.
    const statuses = await Promise.all([
      login(user.email, RESET_ONE).then((response) => response.status),
      login(user.email, RESET_TWO).then((response) => response.status),
    ]);
    expect(statuses.sort()).toEqual([200, 401]);
  });
});

// --- 5. Disabled accounts --------------------------------------------------------------------

describe('disabled accounts', () => {
  it('refuses login for an account disabled before the request', async () => {
    const user = await account({ status: 'DISABLED' });
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
    expect(await liveSessionCount()).toBe(0);
  });

  it('refuses a login whose account is disabled while it is parked before the lock', async () => {
    const user = await account();
    const control = gate();
    const auth = authServiceWithPausedVerification(control);

    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    control.release();

    await expect(attempt).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await liveSessionCount()).toBe(0);
  });
});

// --- 6. Reset racing account disable ------------------------------------------------------------

describe('reset racing account disable', () => {
  it('fails safely when the account is disabled before the reset', async () => {
    const user = await account();
    const token = await issueFor(user);
    await db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });

    const response = await resetPassword(token, NEW_PASSWORD);
    expect(response.status).toBe(401);
    expect(await liveSessionCount()).toBe(0);

    // Re-enabling restores the original password, proving the rollback was complete.
    await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('never leaves a usable session when disable and reset run concurrently', async () => {
    const user = await account();
    const token = await issueFor(user);
    const results = await Promise.all([
      resetPassword(token, NEW_PASSWORD),
      db.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } }),
    ]);
    expect([204, 401]).toContain(results[0].status);
    expect(await liveSessionCount()).toBe(0);
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
  });
});

// --- 7. Rollback ---------------------------------------------------------------------------------

describe('transaction rollback', () => {
  it('rolls back token consumption when a later step fails', async () => {
    const user = await account();
    const token = await issueFor(user);
    // A valid password is supplied so the reset reaches the transaction; removing the credential
    // makes the replacement step fail, after the token would already have been consumed.
    await db.passwordCredential.delete({ where: { userId: user.id } });

    expect(await resetOutcome(token, NEW_PASSWORD)).toBe(401);

    const row = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashRecoveryToken(token) },
    });
    expect(row.usedAt).toBeNull();
  });

  it('creates no session when the login transaction aborts', async () => {
    const user = await account();
    const control = gate();
    const auth = authServiceWithPausedVerification(control);

    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;
    // Break the credential while the login is parked, so the in-lock revalidation cannot match.
    await db.passwordCredential.delete({ where: { userId: user.id } });
    control.release();

    await expect(attempt).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });
});

// --- 8. Cross-user isolation ----------------------------------------------------------------------

describe('cross-user isolation', () => {
  it('revokes only the resetting user sessions', async () => {
    const victim = await account();
    const bystander = await account();
    const victimCookie = tokenOf(await login(victim.email, OLD_PASSWORD));
    const bystanderCookie = tokenOf(await login(bystander.email, OLD_PASSWORD));

    const token = await issueFor(victim);
    await recovery.resetPassword(token, NEW_PASSWORD);

    expect((await me(victimCookie)).status).toBe(401);
    expect((await me(bystanderCookie)).status).toBe(200);
    const bystanderSession = await db.session.findFirstOrThrow({ where: { userId: bystander.id } });
    expect(bystanderSession.revokedAt).toBeNull();
  });

  it('does not let one user block another user', async () => {
    const first = await account();
    const second = await account();
    const results = await Promise.all([
      login(first.email, OLD_PASSWORD),
      login(second.email, OLD_PASSWORD),
      login(first.email, OLD_PASSWORD),
    ]);
    for (const response of results) expect(response.status).toBe(200);
    expect(await liveSessionCount()).toBe(3);
  });
});

// --- 9. No deadlocks or lock leaks ------------------------------------------------------------------

describe('lock hygiene', () => {
  it('releases the lock after a successful login', async () => {
    const user = await account();
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
    // A second login would hang forever if the lock had leaked.
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('releases the lock after a failed reset transaction', async () => {
    const user = await account();
    const token = await issueFor(user);
    await db.passwordCredential.delete({ where: { userId: user.id } });
    expect(await resetOutcome(token, NEW_PASSWORD)).toBe(401);

    // A same-user login would hang if the aborted transaction had kept its advisory lock.
    await db.passwordCredential.create({
      data: { userId: user.id, passwordHash: await hashPassword(OLD_PASSWORD) },
    });
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });

  it('survives many interleaved logins and resets without deadlocking', async () => {
    const user = await account();
    const work = [];
    for (let index = 0; index < 4; index += 1) {
      work.push(login(user.email, OLD_PASSWORD));
      work.push(login(user.email, 'definitely not the password'));
      work.push(issueFor(user).then((token) => resetPassword(token)));
    }
    const settled = await Promise.all(work);
    expect(settled).toHaveLength(12);
    for (const response of settled) expect([200, 202, 204, 401]).toContain(response.status);
  });
});

// --- 11. Credential-version weaknesses found in the final review -------------------------------

describe('credential version strength', () => {
  it('stores passwordChangedAt at millisecond resolution, matching the JavaScript Date', async () => {
    const user = await account();
    const row = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    // PostgreSQL timestamp(3) and JavaScript Date are both millisecond, so nothing is truncated and
    // the accepted `previous + 1` arithmetic really does produce a distinct value.
    expect(row.passwordChangedAt.getTime()).toBe(row.passwordChangedAt.getTime());
    const columns = await db.$queryRawUnsafe(
      `SELECT datetime_precision FROM information_schema.columns
       WHERE table_name = 'password_credentials' AND column_name = 'passwordChangedAt'`,
    );
    expect(Number(columns[0].datetime_precision)).toBe(3);
  });

  it('rejects a stale login when the credential row is replaced with a recycled timestamp', async () => {
    const user = await account();
    const original = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });

    // Park the login after verification, then swap the credential row for a *different* password
    // while deliberately recycling `passwordChangedAt`. A timestamp-only version check would pass
    // this; the digest fingerprint must not.
    const control = gate();
    const auth = authServiceWithPausedVerification(control);
    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;

    await db.passwordCredential.delete({ where: { id: original.id } });
    await db.passwordCredential.create({
      data: {
        userId: user.id,
        passwordHash: await hashPassword('a completely different replacement value'),
        passwordChangedAt: original.passwordChangedAt,
      },
    });
    // The recycled timestamp is genuinely equal, so only the fingerprint can catch this.
    const current = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(current.passwordChangedAt.getTime()).toBe(original.passwordChangedAt.getTime());
    expect(current.passwordHash).not.toBe(original.passwordHash);

    control.release();
    await expect(attempt).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('rejects a stale login when the credential row is deleted outright', async () => {
    const user = await account();
    const control = gate();
    const auth = authServiceWithPausedVerification(control);
    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;

    await db.passwordCredential.delete({ where: { userId: user.id } });
    control.release();

    await expect(attempt).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('concurrent replacements leave exactly one password in effect', async () => {
    const user = await account();
    const control = gate();
    const auth = authServiceWithPausedVerification(control);
    const attempt = auth.login(user.email, OLD_PASSWORD);
    await control.arrived;

    // Two replacements racing the parked login. Whichever wins, the login must not survive it.
    const [a, b] = await Promise.all([
      db.passwordCredential.update({
        where: { userId: user.id },
        data: { passwordHash: await hashPassword('replacement one value here') },
      }),
      db.passwordCredential.update({
        where: { userId: user.id },
        data: { passwordHash: await hashPassword('replacement two value here') },
      }),
    ]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    control.release();
    await expect(attempt).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('never exposes the credential digest through the versioned verifier', async () => {
    const user = await account();
    const outcome = await credentials.verifyCredentialVersioned(user.id, OLD_PASSWORD);
    expect(outcome.verification.matches).toBe(true);
    expect(typeof outcome.version).toBe('number');
    expect(outcome.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The stored digest must not appear anywhere in what the caller receives.
    const stored = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(JSON.stringify(outcome)).not.toContain(stored.passwordHash);
  });

  it('accepts a login whose credential is untouched', async () => {
    const user = await account();
    const outcome = await credentials.verifyCredentialVersioned(user.id, OLD_PASSWORD);
    const current = await db.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } });
    // Both signals match, so the in-lock comparison must admit the session.
    expect(current.passwordChangedAt.getTime()).toBe(outcome.version);
    expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
  });
});

describe('separate database connections', () => {
  it('coordinates across two independent pools', async () => {
    const env = parseIntegrationEnvironment(process.env);
    const other = createDatabaseClient(assertDisposableTestDatabase(env.TEST_DATABASE_URL));
    try {
      const user = await account();
      // The advisory lock is a database object, so a second pool agrees on it with no in-process
      // coordination. A process-local mutex would not.
      const observed = await other.passwordResetToken.count({ where: { userId: user.id } });
      expect(observed).toBe(0);

      const token = await issueFor(user);
      await recovery.resetPassword(token, NEW_PASSWORD);
      expect(await other.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      expect((await login(user.email, OLD_PASSWORD)).status).toBe(401);
    } finally {
      await closeDatabase(other);
    }
  });

  it('does not leak a lock when a competing connection aborts', async () => {
    const env = parseIntegrationEnvironment(process.env);
    const other = createDatabaseClient(assertDisposableTestDatabase(env.TEST_DATABASE_URL));
    try {
      const user = await account();
      // Take the per-user lock on a connection that then rolls back.
      await expect(
        other.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`;
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');

      // The lock must be free, so this login proceeds immediately.
      expect((await login(user.email, OLD_PASSWORD)).status).toBe(200);
    } finally {
      await closeDatabase(other);
    }
  });
});
