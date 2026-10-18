import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, WRONG_PASSWORD, createHarness } from './support/stage210-harness.mjs';

/**
 * Stage 2.10.1 EVT-03: can security events be altered under the application's database role?
 *
 * Owner decision D7: characterize current permissions now. Append-only controls, least-privilege roles, source-address
 * privacy and retention are planned, and NO schema or database-role change is authorized in this step.
 *
 * Isolation. Every row this file modifies or deletes is a row it created itself, for a fixture user it created, in the
 * disposable test database (the harness refuses any other). It never touches an existing event, never truncates, and
 * never changes a privilege; it only ASKS the database what the current role is allowed to do.
 */

const h = createHarness({ secret: 'stage210_audit_suite_rate_limit_key_0123456789abcdefg' });

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.resetState());
afterEach(() => h.cleanup());

const privilege = async (name) => {
  const rows = await h.db.$queryRawUnsafe(
    `SELECT has_table_privilege(current_user, 'authentication_events', '${name}') AS allowed`,
  );
  return rows[0].allowed;
};

describe('EVT-03 security-event mutability', () => {
  it('CHARACTERIZATION (known gap, development only): the application role owns the event table and can rewrite or erase history', async () => {
    // The role the tests (and the local API) connect with is the PostgreSQL superuser created by Docker Compose. It can
    // UPDATE, DELETE and TRUNCATE authentication_events. Nothing in the application does so (next test), but nothing in
    // the database prevents it either. A production deployment needs a least-privilege runtime role that can INSERT and
    // SELECT only, and an append-only guard (decision D7). This pins today's state; it does not describe it as safe.
    const [{ role, superuser }] = await h.db.$queryRaw`
      SELECT current_user::text AS role,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`;
    const [{ owner }] = await h.db.$queryRaw`
      SELECT tableowner::text AS owner FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'authentication_events'`;
    expect(typeof role).toBe('string');
    expect(superuser).toBe(true);
    expect(owner).toBe(role);
    for (const name of ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(await privilege(name), name).toBe(true);
    }
  });

  it('CHARACTERIZATION (known gap): a disposable event row can be re-typed, re-attributed and deleted by the application role', async () => {
    const user = await h.account();
    const other = await h.account();
    expect((await h.login(user.email, WRONG_PASSWORD)).status).toBe(401);
    const failed = await h.db.authenticationEvent.findFirstOrThrow({
      where: { userId: user.id, eventType: 'LOGIN_FAILED' },
    });

    // Rewrite what happened, and to whom: a failed login becomes another user's success.
    const rewritten = await h.db.authenticationEvent.update({
      where: { id: failed.id },
      data: { eventType: 'LOGIN_SUCCEEDED', userId: other.id },
    });
    expect(rewritten.eventType).toBe('LOGIN_SUCCEEDED');
    expect(rewritten.userId).toBe(other.id);
    expect(await h.events(user.id, 'LOGIN_FAILED')).toBe(0);

    // And erase it.
    await h.db.authenticationEvent.delete({ where: { id: failed.id } });
    expect(await h.db.authenticationEvent.findUnique({ where: { id: failed.id } })).toBeNull();
  });

  it('INVARIANT: the user foreign key is RESTRICT, so deleting an account cannot silently drop its security history', async () => {
    // A user with NO credential, so the events are the only thing that can block the deletion: a failed login for it
    // writes a LOGIN_FAILED event attributed to the user (the decoy path still resolves the account).
    const user = await h.account({ password: null });
    expect((await h.login(user.email, PASSWORD)).status).toBe(401);
    expect(await h.events(user.id, 'LOGIN_FAILED')).toBe(1);
    expect(await h.db.session.count({ where: { userId: user.id } })).toBe(0);

    await expect(h.db.user.delete({ where: { id: user.id } })).rejects.toThrow();
    expect(await h.db.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await h.events(user.id)).toBe(1);

    // Once the history is deliberately removed the same deletion succeeds, so the events were the cause of the refusal.
    await h.db.authenticationEvent.deleteMany({ where: { userId: user.id } });
    await h.db.user.delete({ where: { id: user.id } });
    expect(await h.db.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it('INVARIANT: no application code path updates, deletes or truncates security events', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);

    const forbidden = [
      /authenticationEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/,
      /UPDATE\s+"?authentication_events"?/i,
      /DELETE\s+FROM\s+"?authentication_events"?/i,
      /TRUNCATE\b[^;\n]*authentication_events/i,
      /DROP\s+TABLE\b[^;\n]*authentication_events/i,
    ];
    // Negative control: each pattern must recognise a sample of exactly the mutation it exists to catch, otherwise
    // an empty result below would prove nothing.
    const samples = [
      'await tx.authenticationEvent.update({ where: { id }, data: {} });',
      'await this.prisma.authenticationEvent.deleteMany({ where: {} });',
      'await tx.$executeRaw`UPDATE "authentication_events" SET "eventType" = 1`;',
      'await tx.$executeRaw`DELETE FROM "authentication_events"`;',
      'await tx.$executeRaw`TRUNCATE TABLE "authentication_events"`;',
      'await tx.$executeRaw`DROP TABLE "authentication_events"`;',
    ];
    for (const [index, sample] of samples.entries()) {
      expect(
        forbidden.some((pattern) => pattern.test(sample)),
        `the scan recognises sample ${index + 1}`,
      ).toBe(true);
    }

    const offences = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(text)) offences.push(`${relative(root, file)}: ${pattern}`);
      }
    }
    expect(offences).toEqual([]);

    // The scan is meaningful only if it can see the writers it is protecting: they must be present.
    const recorder = readFileSync(join(root, 'identity', 'security-event-recorder.ts'), 'utf8');
    expect(recorder).toMatch(/authenticationEvent\.create/);
    expect(recorder).toMatch(/INSERT INTO "authentication_events"/);
  });
});
