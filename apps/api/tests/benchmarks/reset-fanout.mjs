/**
 * Stage 2.7 measurement: how a password reset behaves as the number of live sessions grows.
 *
 * Not a test and not run by any suite. Run by hand against the disposable test database:
 *
 *   pnpm build && node apps/api/tests/benchmarks/reset-fanout.mjs [trials] [size ...]
 *
 * For each size it creates a synthetic user owning that many live sessions (seeded with one SQL statement),
 * performs a real reset through the real service, and records the wall-clock time, whether it succeeded,
 * how many sessions were actually revoked, how many `SESSION_REVOKED` rows exist, the write-ahead-log volume
 * of the reset, and the growth of the Node process's resident memory. It removes only the rows it created.
 *
 * Set BASELINE_REVOKE_ONLY=1 to time the accepted pre-Stage-2.7 behaviour instead (revoke, no events).
 *
 * Results depend on the machine and on database state (bloat, autovacuum, cache), so report several trials
 * and treat a single run as an observation, not a guarantee.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseIntegrationEnvironment } from '@tsms/config';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { assertDisposableTestDatabase } from '@tsms/database/testing';
import { createRedisClient, closeRedis } from '@tsms/redis';
import { hashPassword } from '../../dist/identity/password-hasher.js';
import { PasswordRecoveryService } from '../../dist/identity/password-recovery.service.js';
import { InMemoryRecoveryDelivery } from '../../dist/identity/password-recovery-delivery.js';
import { admissionFor } from '../support/stage29-wiring.mjs';
import { SecurityLog } from '../../dist/identity/security-log.js';
import { SecurityEventRecorder } from '../../dist/identity/security-event-recorder.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
} from '../../dist/identity/password-recovery-token.js';

process.loadEnvFile(new URL('../../../../.env', import.meta.url));
process.env.NODE_ENV = 'test';

const trials = Number(process.argv[2] ?? 3);
const sizes = process.argv.slice(3).map(Number);
if (sizes.length === 0) sizes.push(1_000, 5_000, 10_000, 20_000, 50_000);

const env = parseIntegrationEnvironment(process.env);
const db = createDatabaseClient(assertDisposableTestDatabase(env.TEST_DATABASE_URL));
const redis = createRedisClient(env.TEST_REDIS_URL);
const log = new SecurityLog({ sink: () => {} });
let lastCause = '';
const observed = new Proxy(db, {
  get(target, property) {
    if (property === '$transaction') {
      return async (...args) => {
        try {
          return await target.$transaction(...args);
        } catch (error) {
          lastCause = `${error?.name} ${error?.code ?? ''}`.trim();
          throw error;
        }
      };
    }
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const recovery = new PasswordRecoveryService(
  observed,
  new InMemoryRecoveryDelivery(),
  { mode: 'development-only', urlBase: 'https://app.example.test/r' },
  admissionFor(redis),
  new SecurityEventRecorder(observed, log),
  log,
);

const wal = async () => (await db.$queryRaw`SELECT pg_current_wal_lsn()::text AS lsn`)[0].lsn;
const walBytes = async (from, to) =>
  Number(
    (
      await db.$queryRaw`SELECT (pg_wal_lsn_diff(${to}::pg_lsn, ${from}::pg_lsn))::bigint AS bytes`
    )[0].bytes,
  );
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const rows = [];
for (const n of sizes) {
  const results = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    const email = `${randomUUID()}@example.test`;
    const user = await db.user.create({
      data: { email, normalizedEmail: email, displayName: 'Synthetic', status: 'ACTIVE' },
    });
    try {
      await db.passwordCredential.create({
        data: { userId: user.id, passwordHash: await hashPassword('the original password value') },
      });
      await db.$executeRaw`
        INSERT INTO "sessions" ("id", "userId", "tokenHash", "expiresAt")
        SELECT gen_random_uuid(), ${user.id}::uuid, md5(random()::text || g::text) || md5(random()::text),
               now() + interval '7 days'
        FROM generate_series(1, ${n}) AS g`;
      const raw = generateRecoveryToken();
      await db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRecoveryToken(raw),
          expiresAt: new Date(Date.now() + 1.8e6),
        },
      });
      await db.$queryRaw`SELECT 1`;
      globalThis.gc?.();
      const rssBefore = process.memoryUsage().rss;
      const lsnBefore = await wal();
      lastCause = '';
      const t0 = performance.now();
      let outcome = 'ok';
      try {
        if (process.env.BASELINE_REVOKE_ONLY === '1') {
          // The accepted pre-Stage-2.7 behaviour: revoke in one statement and write no event.
          await observed.$transaction(async (tx) => {
            await tx.session.updateMany({
              where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
              data: { revokedAt: new Date() },
            });
          });
        } else {
          await recovery.resetPassword(raw, 'a brand new password value');
        }
      } catch (error) {
        outcome = `FAILED ${error?.code} ${lastCause}`.trim();
      }
      const ms = performance.now() - t0;
      const lsnAfter = await wal();
      const rssGrowth = process.memoryUsage().rss - rssBefore;
      results.push({
        outcome,
        ms,
        revoked: await db.session.count({ where: { userId: user.id, revokedAt: { not: null } } }),
        events: await db.authenticationEvent.count({
          where: { userId: user.id, eventType: 'SESSION_REVOKED' },
        }),
        completed: await db.authenticationEvent.count({
          where: { userId: user.id, eventType: 'PASSWORD_RESET_COMPLETED' },
        }),
        walMiB: (await walBytes(lsnBefore, lsnAfter)) / 1048576,
        rssGrowthMiB: rssGrowth / 1048576,
      });
    } finally {
      await db.authenticationEvent.deleteMany({ where: { userId: user.id } });
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await db.passwordCredential.deleteMany({ where: { userId: user.id } });
      await db.user.deleteMany({ where: { id: user.id } });
    }
  }
  const times = results.map((r) => r.ms);
  const line = {
    sessions: n,
    trials,
    outcomes: [...new Set(results.map((r) => r.outcome))].join(' | '),
    msMin: Math.round(Math.min(...times)),
    msMedian: Math.round(median(times)),
    msMax: Math.round(Math.max(...times)),
    revoked: [...new Set(results.map((r) => r.revoked))].join(','),
    sessionRevokedRows: [...new Set(results.map((r) => r.events))].join(','),
    completedRows: [...new Set(results.map((r) => r.completed))].join(','),
    walMiB: Number(median(results.map((r) => r.walMiB)).toFixed(1)),
    rssGrowthMiB: Number(median(results.map((r) => r.rssGrowthMiB)).toFixed(1)),
  };
  rows.push(line);
  console.log(JSON.stringify(line));
}

await closeRedis(redis);
await closeDatabase(db);
