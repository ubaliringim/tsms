import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARGON2ID_SEMAPHORE_KEY, closeRedis, createRedisClient } from '@tsms/redis';
import { PASSWORD, TRUSTED_ORIGIN, createHarness } from './support/stage210-harness.mjs';
import { SessionService } from '../dist/identity/session.service.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
} from '../dist/identity/password-recovery-token.js';
import { ARGON2ID_CONCURRENCY } from '../dist/identity/auth-abuse-policy.js';

/**
 * Stage 2.10.1 CON-04: shutdown during Argon2id hashing and during a password reset.
 *
 * Three different mechanisms can end an in-flight operation, and they are asserted separately because they give
 * different guarantees:
 *
 *   graceful stop    `app.close()` (what Nest's shutdown hooks run on SIGTERM). The server stops accepting connections
 *                    and lets in-flight requests finish; the Argon2id slot is released by the request's own `finally`,
 *                    BEFORE Redis and PostgreSQL are closed.
 *   hard stop        the process is killed (SIGKILL / power loss). Nothing runs. A held Argon2id slot is NOT released;
 *                    it stays in Redis until its lease expires (30 s). An open transaction is rolled back by PostgreSQL
 *                    when the connection drops.
 *   lease expiry     the only recovery for the hard stop. This file asserts the lease is bounded; it does not wait for it.
 *
 * Each test starts a REAL API process (support/stage210-server-child.mjs), waits until the semaphore in Redis shows that
 * hashing has actually begun, and only then stops it, so the stop lands inside the operation and not before or after it.
 *
 * Isolation: the semaphore is shared deployment state. Each test snapshots the holders before it starts, and removes
 * only the holders that appeared during the test and were left behind by a killed process. It never clears the key.
 *
 * Platform note: on Windows a signal terminates a process without running handlers, so the graceful stop is driven by an
 * IPC message that calls the same `app.close()`; on other platforms it is a real SIGTERM through Nest's shutdown hooks.
 */

const CHILD = fileURLToPath(new URL('./support/stage210-server-child.mjs', import.meta.url));
const SECRET = 'stage210_shutdown_suite_rate_limit_key_0123456789abc';
const NEW_PASSWORD = 'a brand new password value';
const IN_FLIGHT = 4; // below the semaphore capacity of 8, so a killed batch cannot saturate the deployment

const h = createHarness({ secret: SECRET });
let redis;
/** Every API process this file starts, so none can outlive its test whatever happens in between. */
const started = [];

beforeAll(async () => {
  await h.start();
  redis = createRedisClient(h.env.TEST_REDIS_URL);
});
afterAll(async () => {
  if (redis) await closeRedis(redis);
  await h.stop();
});
beforeEach(() => h.resetState());
afterEach(async () => {
  for (const server of started.splice(0)) {
    if (server.child.exitCode === null && server.child.signalCode === null)
      server.child.kill('SIGKILL');
  }
  await h.cleanup();
});

// --- semaphore helpers ---------------------------------------------------------------------------------------------

/** member -> lease expiry (Redis epoch milliseconds) */
async function holders() {
  const flat = await redis.zrange(ARGON2ID_SEMAPHORE_KEY, 0, -1, 'WITHSCORES');
  const map = new Map();
  for (let index = 0; index < flat.length; index += 2)
    map.set(flat[index], Number(flat[index + 1]));
  return map;
}

async function redisNowMillis() {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/** Wait until at least `count` holders that were not present at `baseline` exist. */
async function waitForHolders(baseline, count, limitMillis = 8_000) {
  const deadline = Date.now() + limitMillis;
  for (;;) {
    const current = await holders();
    const added = [...current.keys()].filter((member) => !baseline.has(member));
    if (added.length >= count) return added;
    if (Date.now() > deadline) {
      throw new Error(
        `Argon2id hashing never started: ${added.length} of ${count} new holders seen`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Holders that appeared after `baseline` and are still held. */
async function leakedSince(baseline) {
  const current = await holders();
  return new Map([...current].filter(([member]) => !baseline.has(member)));
}

/** Remove ONLY the holders a killed process left behind during this test. */
async function removeLeaked(leaked) {
  if (leaked.size > 0) await redis.zrem(ARGON2ID_SEMAPHORE_KEY, ...leaked.keys());
}

// --- child process helpers -----------------------------------------------------------------------------------------

async function startServer() {
  const child = fork(CHILD, [], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      STAGE210_CHILD_CONFIG: JSON.stringify({
        DATABASE_URL: h.env.TEST_DATABASE_URL,
        REDIS_URL: h.env.TEST_REDIS_URL,
        API_TRUSTED_ORIGINS: [TRUSTED_ORIGIN],
        API_RATE_LIMIT_HMAC_SECRET: SECRET,
      }),
    },
  });
  let stderr = '';
  child.stderr.on('data', (data) => (stderr = (stderr + data).slice(-4000)));
  child.stdout.on('data', () => undefined);
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const listening = new Promise((resolve, reject) => {
    child.on('message', (message) => message?.type === 'listening' && resolve(message.url));
    child.once('exit', () => reject(new Error(`the API process exited during startup: ${stderr}`)));
    setTimeout(
      () => reject(new Error('the API process did not start within 40 s')),
      40_000,
    ).unref();
  });
  const server = { child, exited, stderr: () => stderr };
  started.push(server);
  server.url = await listening;
  return server;
}

/** `app.close()` in the child: a real SIGTERM where signals run handlers, an equivalent IPC message elsewhere. */
function stopGracefully(server) {
  if (process.platform === 'win32') server.child.send('close');
  else server.child.kill('SIGTERM');
}

function stopHard(server) {
  server.child.kill('SIGKILL');
}

/**
 * A graceful stop ends the process cleanly. How that is reported depends on the route: the IPC route (used on Windows)
 * ends with `process.exit(0)`. Nest's SIGTERM route runs the shutdown sequence and then re-raises the signal on itself
 * (`process.kill(process.pid, signal)` in NestApplicationContext.listenToShutdownSignals), so on Linux the process ends
 * with signal SIGTERM and no exit code. Both are a clean shutdown; a crash is neither (a non-zero code, or any other
 * signal).
 */
function expectGracefulExit(exit, server) {
  const clean =
    process.platform === 'win32'
      ? exit.code === 0
      : exit.code === 0 || (exit.code === null && exit.signal === 'SIGTERM');
  expect(clean, `unclean exit ${JSON.stringify(exit)}: ${server.stderr()}`).toBe(true);
}

async function exitWithin(server, millis) {
  const result = await Promise.race([
    server.exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), millis)),
  ]);
  if (result === 'timeout') {
    server.child.kill('SIGKILL');
    throw new Error(`the API process did not exit within ${millis} ms: ${server.stderr()}`);
  }
  return result;
}

const outcome = (promise) =>
  promise.then(
    (response) => ({ status: response.status }),
    (error) => ({ failed: error?.cause?.code ?? error?.code ?? error?.message ?? 'error' }),
  );

/** Bounded, so a stalled server fails this request instead of hanging the test. */
const post = (url, path, body) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

// --- fixtures ------------------------------------------------------------------------------------------------------

async function loginUsers(count) {
  const users = [];
  for (let index = 0; index < count; index += 1) users.push(await h.account());
  return users;
}

/** An account with one live session and one live recovery token, created directly so no Argon2id slot is spent. */
async function resetCandidates(count) {
  const sessions = new SessionService(h.db);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const user = await h.account({ password: PASSWORD });
    await sessions.createSession(user.id);
    const token = generateRecoveryToken();
    await h.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRecoveryToken(token),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const credential = await h.db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    candidates.push({ user, token, hashBefore: credential.passwordHash });
  }
  return candidates;
}

/** 'untouched' or 'complete'. Anything else is a half-applied reset and fails the test. */
async function resetStateOf({ user, token, hashBefore }) {
  const credential = await h.db.passwordCredential.findUniqueOrThrow({
    where: { userId: user.id },
  });
  const row = await h.db.passwordResetToken.findUniqueOrThrow({
    where: { tokenHash: hashRecoveryToken(token) },
  });
  const live = await h.liveSessions(user.id);
  const completed = await h.events(user.id, 'PASSWORD_RESET_COMPLETED');
  const revoked = await h.events(user.id, 'SESSION_REVOKED');
  const changed = credential.passwordHash !== hashBefore;
  if (!changed) {
    expect(row.usedAt, 'untouched: the token is unused').toBeNull();
    expect(live, 'untouched: the session is live').toBe(1);
    expect([completed, revoked], 'untouched: no events').toEqual([0, 0]);
    return 'untouched';
  }
  expect(row.usedAt, 'complete: the token is consumed').not.toBeNull();
  expect(live, 'complete: the sessions are revoked').toBe(0);
  expect([completed, revoked], 'complete: one completion and one revocation event').toEqual([1, 1]);
  return 'complete';
}

/** 0 or 1 sessions, and exactly as many LOGIN_SUCCEEDED events. A session without its event (or the reverse) fails. */
async function loginStateOf(user) {
  const sessions = await h.db.session.count({ where: { userId: user.id } });
  const succeeded = await h.events(user.id, 'LOGIN_SUCCEEDED');
  expect(succeeded, 'a session and its LOGIN_SUCCEEDED event exist together or not at all').toBe(
    sessions,
  );
  expect(sessions).toBeLessThanOrEqual(1);
  return sessions === 1 ? 'logged-in' : 'none';
}

const LEASE_MILLIS = ARGON2ID_CONCURRENCY.leaseMillis;

describe('CON-04 shutdown during Argon2id hashing', () => {
  it('INVARIANT: a graceful stop during login hashing lets in-flight logins finish, releases every slot, and leaves atomic state', async () => {
    const users = await loginUsers(IN_FLIGHT);
    const baseline = await holders();
    const server = await startServer();
    try {
      const requests = users.map((user) =>
        outcome(post(server.url, '/auth/login', { email: user.email, password: PASSWORD })),
      );
      await waitForHolders(baseline, 2);
      stopGracefully(server);
      const results = await Promise.all(requests);
      const exit = await exitWithin(server, 25_000);

      expectGracefulExit(exit, server);
      // Graceful: nothing is cut off. Each request got a real answer, and every answer was a success.
      for (const result of results)
        expect(result, JSON.stringify(results)).toEqual({ status: 200 });

      // Immediate release: the request's own `finally` released each slot before Redis was closed.
      const leaked = await leakedSince(baseline);
      await removeLeaked(leaked); // hygiene only; asserted below
      expect([...leaked.keys()], 'a graceful stop leaves no slot held').toEqual([]);

      for (const user of users) expect(await loginStateOf(user)).toBe('logged-in');
    } finally {
      if (server.child.exitCode === null) stopHard(server);
    }
  }, 90_000);

  it('CHARACTERIZATION: a hard stop during login hashing leaves the slots held until their lease expires, and no session behind', async () => {
    // A killed process cannot release anything. The documented recovery is lease expiry (30 s), asserted here as a bound
    // and not waited for. With fewer holders than the capacity the deployment keeps serving in the meantime; a batch of
    // eight killed in flight would block hashing for up to the lease (the lease-expiry model, accepted since Stage 2.6).
    const users = await loginUsers(IN_FLIGHT);
    const survivor = await h.account();
    const baseline = await holders();
    const server = await startServer();
    let leaked = new Map();
    try {
      const requests = users.map((user) =>
        outcome(post(server.url, '/auth/login', { email: user.email, password: PASSWORD })),
      );
      await waitForHolders(baseline, 2);
      stopHard(server);
      await exitWithin(server, 10_000);
      const results = await Promise.all(requests);

      leaked = await leakedSince(baseline);
      expect(leaked.size, 'a killed process leaves its slots held').toBeGreaterThanOrEqual(1);
      expect(leaked.size).toBeLessThanOrEqual(IN_FLIGHT);
      const now = await redisNowMillis();
      for (const [, expiry] of leaked) {
        expect(expiry - now, 'the lease is still in the future').toBeGreaterThan(0);
        expect(expiry - now, 'and bounded by the 30 s lease').toBeLessThanOrEqual(LEASE_MILLIS);
      }

      // Atomic: no half-created login. A client that never got an answer has no session; one that did, has exactly one.
      const states = [];
      for (const [index, user] of users.entries()) {
        const state = await loginStateOf(user);
        states.push(state);
        if (results[index].status === 200) expect(state).toBe('logged-in');
      }
      // The stop really landed inside the operation: at least one login was cut off before it created a session.
      expect(states, 'the kill must interrupt at least one login').toContain('none');

      // The deployment is not wedged: the remaining capacity still serves a login on the in-process API.
      expect((await h.login(survivor.email, PASSWORD)).status).toBe(200);
    } finally {
      if (server.child.exitCode === null) stopHard(server);
      await removeLeaked(leaked);
    }
  }, 90_000);
});

describe('CON-04 shutdown during a password reset', () => {
  it('INVARIANT: a graceful stop during reset hashing lets in-flight resets finish and leaves each account complete', async () => {
    const candidates = await resetCandidates(IN_FLIGHT);
    const baseline = await holders();
    const server = await startServer();
    try {
      const requests = candidates.map(({ token }) =>
        outcome(post(server.url, '/auth/password/reset', { token, newPassword: NEW_PASSWORD })),
      );
      await waitForHolders(baseline, 2);
      stopGracefully(server);
      const results = await Promise.all(requests);
      const exit = await exitWithin(server, 25_000);

      expectGracefulExit(exit, server);
      for (const result of results)
        expect(result, JSON.stringify(results)).toEqual({ status: 204 });
      const leaked = await leakedSince(baseline);
      await removeLeaked(leaked);
      expect([...leaked.keys()], 'a graceful stop leaves no slot held').toEqual([]);
      for (const candidate of candidates) expect(await resetStateOf(candidate)).toBe('complete');
    } finally {
      if (server.child.exitCode === null) stopHard(server);
    }
  }, 90_000);

  it('INVARIANT: a hard stop during reset hashing never half-applies a reset, and an untouched token is still usable afterwards', async () => {
    const candidates = await resetCandidates(IN_FLIGHT);
    const baseline = await holders();
    const server = await startServer();
    let leaked = new Map();
    try {
      candidates.forEach(({ token }) =>
        outcome(post(server.url, '/auth/password/reset', { token, newPassword: NEW_PASSWORD })),
      );
      await waitForHolders(baseline, 2);
      stopHard(server);
      await exitWithin(server, 10_000);
      leaked = await leakedSince(baseline);

      // PostgreSQL rolled back whatever was open. Every account is wholly untouched or wholly reset.
      const states = [];
      for (const candidate of candidates) states.push(await resetStateOf(candidate));
      expect(states.every((state) => state === 'untouched' || state === 'complete')).toBe(true);
      // The stop really landed inside the operation: at least one reset was cut off before it committed.
      expect(states, 'the kill must interrupt at least one reset').toContain('untouched');

      // A reset that did not happen did not burn the token: the same link still works on a healthy instance.
      for (const [index, candidate] of candidates.entries()) {
        if (states[index] !== 'untouched') continue;
        const retry = await h.resetPassword(candidate.token, NEW_PASSWORD);
        expect(retry.status, 'the unused token is accepted').toBe(204);
        expect(await resetStateOf(candidate)).toBe('complete');
      }
    } finally {
      if (server.child.exitCode === null) stopHard(server);
      await removeLeaked(leaked);
    }
  }, 120_000);
});
