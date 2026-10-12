import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { createDatabaseClient, closeDatabase } from '@tsms/database';
import { hashPassword } from '../../api/dist/identity/password-hasher.js';
import { resetRateLimitState } from '../../api/tests/support/rate-limit-state.mjs';
import { clearOrphanSecurityEvents } from '../../api/tests/support/event-cleanup.mjs';

export const PASSWORD = 'correct horse battery staple';
export const WRONG_PASSWORD = 'entirely different secret phrase';

/**
 * Browser-suite fixtures: a database handle, synthetic accounts that are removed afterwards (only those this
 * test created), and a fresh limiter on the suite's own Redis database before every test.
 */
export const test = base.extend({
  // Playwright requires the first fixture argument to be a destructuring pattern, even an empty one.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => use(process.env.E2E_WEB_ORIGIN),

  db: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const db = createDatabaseClient(process.env.E2E_DATABASE_URL);
      await use(db);
      await closeDatabase(db);
    },
    { scope: 'worker' },
  ],

  accounts: async ({ db }, use) => {
    await resetRateLimitState(process.env.E2E_REDIS_URL);
    const ids = [];
    const create = async ({ status = 'ACTIVE', displayName = 'Synthetic Identity' } = {}) => {
      const email = `${randomUUID()}@example.test`;
      const user = await db.user.create({
        data: { email, normalizedEmail: email, displayName, status },
      });
      ids.push(user.id);
      await db.passwordCredential.create({
        data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) },
      });
      return user;
    };
    await use({ create, ids });
    // authentication_events is ON DELETE RESTRICT, so events go first; only this test's users are touched.
    await db.authenticationEvent.deleteMany({ where: { userId: { in: ids } } });
    await clearOrphanSecurityEvents(db);
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.passwordCredential.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  },
});

export { expect };

/** Fill and submit the sign-in form with the mouse helpers (used where the path is not under test). */
export async function signIn(page, email, password = PASSWORD) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
