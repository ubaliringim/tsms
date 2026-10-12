/**
 * Stage 2.7 - security event persistence.
 *
 * ## The two write paths, and why they differ
 *
 * `inTransaction` and `detached` look like duplication and are not:
 *
 * - **Success events are transactionally coupled.** `LOGIN_SUCCEEDED` is written on the same Prisma
 *   transaction that inserts the session, `PASSWORD_RESET_COMPLETED` on the transaction that replaces the
 *   credential, and `PASSWORD_RESET_REQUESTED` on the transaction that issues the token. If the operation
 *   rolls back, the event rolls back with it, and if the event insert fails, the operation fails. That
 *   coupling is the only way to guarantee the property the stage actually needs: **a committed success
 *   event always corresponds to a committed operation.** There is no window in which one exists without
 *   the other.
 *
 *   The cost is availability: if the `authentication_events` table cannot be written, logins and resets
 *   fail. That is deliberate. A login that succeeds with no audit record is the failure mode an audit
 *   trail exists to prevent, and the alternative - best-effort success logging - silently loses records
 *   precisely during the incidents where they matter.
 *
 * - **Failure events are best-effort.** `LOGIN_FAILED` is written after the outcome is already known and
 *   the request is already failing. Coupling it to a transaction would change nothing about the outcome
 *   and could only convert a `401` into a `503`, which would hand an attacker a signal distinguishing
 *   "wrong password" from "audit write failed". So a failure is recorded best-effort, and a write failure
 *   is reported through the security log rather than swallowed.
 *
 * ## Nothing here accepts a payload
 *
 * The recorder's input is a closed event type, an optional user id, and an optional correlation id. There
 * is no metadata parameter, no context object, and no spread of caller-supplied fields. A caller cannot
 * write a password, a token, an address, or a driver error into an event even by accident, because there
 * is no argument through which to pass one.
 */

import type { PrismaClient } from '@tsms/database';
import type { SecurityEventType } from './security-event.js';
import { sanitizedUuid, securityEventTypeOf } from './security-event.js';
import type { SecurityLog } from './security-log.js';

export interface SecurityEventInput {
  /** Must be a known `AuthenticationEventType`. Anything else is dropped. */
  readonly eventType: SecurityEventType | unknown;
  /** Known user id, or `null` when the identity is genuinely unknown. */
  readonly userId?: unknown;
  /** Server-generated correlation id. */
  readonly requestId?: unknown;
}

/**
 * Build the row.
 *
 * Split out so both write paths share exactly one definition of what a valid row is, and so the unit tests
 * can assert the shape without a database.
 */
export function securityEventRow(input: SecurityEventInput): {
  eventType: SecurityEventType;
  userId: string | null;
  requestId: string | null;
} {
  const eventType = securityEventTypeOf(input.eventType);
  if (eventType === undefined) {
    // An unknown type is a programming error. Refusing to invent one keeps the table meaningful: a row
    // that claims to be a login failure when it is not is worse than an absent row.
    throw new Error('Unknown authentication event type');
  }
  return {
    eventType,
    userId: sanitizedUuid(input.userId) ?? null,
    requestId: sanitizedUuid(input.requestId) ?? null,
  };
}

export class SecurityEventRecorder {
  constructor(
    private readonly prisma: Pick<PrismaClient, 'authenticationEvent'>,
    private readonly securityLog: SecurityLog,
  ) {}

  /**
   * Write an event on an existing transaction.
   *
   * Takes the `tx` the caller already holds, so it participates in that transaction's commit and rollback
   * rather than opening a second connection. A failure propagates: on a success path that is the point.
   */
  async inTransaction(
    tx: Pick<PrismaClient, 'authenticationEvent'>,
    input: SecurityEventInput,
  ): Promise<void> {
    const row = securityEventRow(input);
    try {
      await tx.authenticationEvent.create({ data: row, select: { id: true } });
    } catch (error) {
      this.reportWriteFailure(row, error);
      throw error;
    }
  }

  /**
   * Revoke every live session of one user and record exactly one `SESSION_REVOKED` event per session this
   * statement revoked, as a single set-based statement on the caller's transaction.
   *
   * ## Why one statement
   *
   * A reset used to revoke with `updateMany` and then write one event row per session from the
   * application. At about 20,000 live sessions that exceeded Prisma's interactive-transaction timeout and
   * the reset failed closed, so the audit trail had become a ceiling on account recovery. Writing the
   * events inside the same statement that revokes removes the per-row round trips and holds nothing in
   * application memory, however many sessions there are.
   *
   * ## Why the events are exact
   *
   * The events are selected from the rows the `UPDATE` itself returned (`RETURNING`), in the same
   * statement. There is no earlier read or count to go stale. Logout does not take the per-user lock, so a
   * session it revokes first is simply not matched by this `UPDATE` under READ COMMITTED (the row is
   * re-checked after the other transaction commits), is not returned, and gets no event here - it has its
   * own `LOGOUT`. A data-modifying CTE always runs to completion, so the revocation and the inserts cannot
   * disagree, and the insert's failure aborts the statement and with it the caller's transaction.
   *
   * ## Identifiers
   *
   * The schema's `@default(uuid(7))` is applied by the Prisma client, not by the database, and
   * PostgreSQL 17 has no `uuidv7()` (it arrives in 18). The id is therefore built in SQL to the same
   * RFC 9562 layout: a 48-bit Unix-millisecond timestamp, version 7, the RFC variant, and the remaining
   * bits from `gen_random_uuid()` (core since PostgreSQL 13, no extension needed). Ids are valid and
   * time-ordered to the millisecond; within one millisecond they are random rather than counter-ordered,
   * which the RFC permits and nothing here depends on. A collision would violate the primary key and fail
   * the statement, never write a duplicate.
   *
   * ## Safety
   *
   * Every value is a bound parameter, the user id and correlation id pass through the same UUID
   * normalisation as every other event, the event type is a literal, and no caller text reaches the SQL.
   * The timestamp is passed as epoch milliseconds and converted in SQL, because a `Date` parameter's
   * rendering depends on the driver's time zone handling and `sessions` stores a zone-less UTC `timestamp`.
   *
   * @returns how many sessions were revoked, which equals how many events were written.
   */
  async revokeLiveSessionsRecordingEvents(
    tx: Pick<PrismaClient, '$executeRaw'>,
    input: { readonly userId: unknown; readonly revokedAt: Date; readonly requestId?: unknown },
  ): Promise<number> {
    const userId = sanitizedUuid(input.userId);
    if (userId === undefined) throw new Error('A session revocation needs a valid user id');
    const epochMillis = input.revokedAt.getTime();
    if (!Number.isFinite(epochMillis)) throw new Error('A session revocation needs a valid time');
    const requestId = sanitizedUuid(input.requestId) ?? null;
    try {
      return await tx.$executeRaw`
        WITH moment AS (
          SELECT (to_timestamp(${epochMillis}::double precision / 1000.0) AT TIME ZONE 'UTC') AS at
        ),
        revoked AS (
          UPDATE "sessions" AS s
          SET "revokedAt" = moment.at
          FROM moment
          WHERE s."userId" = ${userId}::uuid
            AND s."revokedAt" IS NULL
            AND s."expiresAt" > moment.at
          RETURNING s."id"
        )
        INSERT INTO "authentication_events" ("id", "userId", "eventType", "requestId")
        SELECT
          encode(
            set_bit(
              set_bit(
                overlay(
                  uuid_send(gen_random_uuid())
                  PLACING substring(
                    int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3
                  ) FROM 1 FOR 6
                ),
                52, 1
              ),
              53, 1
            ),
            'hex'
          )::uuid,
          ${userId}::uuid,
          'SESSION_REVOKED'::"AuthenticationEventType",
          CAST(${requestId} AS text)
        FROM revoked`;
    } catch (error) {
      // The driver error is deliberately not logged: it can carry the statement and bound parameters.
      this.reportWriteFailure({ eventType: 'SESSION_REVOKED', userId }, error);
      throw error;
    }
  }

  /**
   * Write an event outside any transaction, best-effort.
   *
   * Never rejects, for any reason: an invalid input, a database error, and a logging failure are all
   * contained here, so an un-awaited call cannot become an unhandled rejection either. Used only for
   * outcomes that are already decided, where turning an audit write failure into a different response
   * would be a new information leak. The caller still awaits it, so the write happens before the response
   * is sent; it adds the same single insert to every refusal path.
   */
  async detached(input: SecurityEventInput): Promise<void> {
    let row: ReturnType<typeof securityEventRow> | undefined;
    try {
      row = securityEventRow(input);
      await this.prisma.authenticationEvent.create({ data: row, select: { id: true } });
    } catch (error) {
      this.reportWriteFailure(row ?? { eventType: 'unknown', userId: null }, error);
    }
  }

  private reportWriteFailure(
    row: { eventType: string; userId: string | null },
    error: unknown,
  ): void {
    // The original error is deliberately not logged. A Prisma failure can carry the statement, the bound
    // parameters, and connection details. The security log reports that the write failed, for which event,
    // and nothing else.
    void error;
    this.securityLog.record('security_event_write_failed', {
      reason: 'event_write_failed',
      userId: row.userId ?? undefined,
    });
  }
}
