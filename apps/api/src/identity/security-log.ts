/**
 * Stage 2.7 - bounded, sanitised operational security log.
 *
 * ## Why failures and denials are logged rather than stored as events
 *
 * Three required security questions - "was this request rejected by abuse protection?", "did an
 * authentication dependency fail?", "was this recovery token rejected?" - have no representable
 * `AuthenticationEventType`. Rather than record a *nearby* event type and corrupt the audit trail, they
 * are emitted here as structured lines with a strict field allowlist.
 *
 * They are also all **per-request, attacker-triggerable, and not attributable to a user**, which makes
 * them the dangerous half for volume:
 *
 * - A rate-limit denial can be produced without limit: an attacker who is being told to back off can
 *   keep asking, and each refusal would otherwise be a fresh `INSERT`. Recording every refusal turns the
 *   abuse limiter into a database-amplification attack, because the write happens exactly when the system
 *   is asking the caller to stop.
 * - A Redis outage and an Argon2id refusal are produced in floods by the same traffic that triggers them.
 * - A rejected recovery token can be produced per distinct token digest, so the per-token meter does not
 *   bound it.
 *
 * So emission is bounded per `(kind, endpoint)` pair: the first record in a window is written, further
 * records in that window are counted, and exactly one summary is emitted when the window rolls. The
 * worst case is two lines per key per window regardless of how hard the endpoint is hammered.
 *
 * By contrast the *stored* events are inherently bounded and need no throttle: `LOGIN_FAILED` cannot
 * exceed the Stage 2.6 credential meter, and logout/reset events require a real session or a real token.
 * That asymmetry is the reason the throttle exists only here.
 *
 * ## What can never appear in a line
 *
 * No raw error, no stack, no request object, no header, no body, no token, no email, no client IP
 * address. Field values come from closed enumerations plus two UUID-shaped columns, so there is no path
 * by which caller-supplied text reaches the log.
 */

import type { SecurityEventEndpoint } from './security-event.js';
import { sanitizedUuid, securityEndpointOf } from './security-event.js';

/**
 * Closed set of operational conditions worth a log line.
 *
 * Each maps to a question an operator actually asks. The `*_suppressed` entry is produced by the throttle
 * itself rather than by a call site.
 */
export const SECURITY_LOG_KINDS = [
  'auth_rate_limited',
  'auth_enforcement_unavailable',
  'argon2id_admission_refused',
  'recovery_token_rejected',
  'security_event_write_failed',
  'unhandled_request_error',
  'security_log_suppressed',
] as const;

export type SecurityLogKind = (typeof SECURITY_LOG_KINDS)[number];

/** Fixed machine-readable reasons. Never a free-text message and never an exception message. */
export type SecurityLogReason =
  | 'rate_limited'
  | 'redis_unavailable'
  | 'argon2id_saturated'
  | 'argon2id_unavailable'
  | 'token_rejected'
  | 'event_write_failed'
  | 'unhandled_error';

export interface SecurityLogFields {
  /** Server-generated correlation id. Normalised to a UUID or dropped. */
  readonly requestId?: unknown;
  /** Closed endpoint set. Unknown values are dropped rather than logged. */
  readonly endpoint?: unknown;
  /** Known user id. Normalised to a UUID or dropped. */
  readonly userId?: unknown;
  /** Closed reason set. Unknown values are dropped. */
  readonly reason?: SecurityLogReason | unknown;
  /** Small non-negative integer, e.g. how many Argon2id leases were held. */
  readonly count?: unknown;
  /** How many identical records the throttle absorbed. */
  readonly suppressed?: unknown;
}

/** One emitted line, after sanitisation. Field names are fixed here and nowhere else. */
export interface SanitizedSecurityRecord {
  readonly kind: SecurityLogKind | string;
  readonly requestId?: string;
  readonly endpoint?: SecurityEventEndpoint;
  readonly userId?: string;
  readonly reason?: SecurityLogReason;
  readonly count?: number;
  readonly suppressed?: number;
}

export type SecurityLogSink = (record: SanitizedSecurityRecord) => void;

/**
 * Injection token for the single per-process security log.
 *
 * A token rather than the class itself so the consumer is explicit about receiving the shared instance
 * rather than a new one.
 */
export const SECURITY_LOG = 'SECURITY_LOG';

interface ThrottleEntry {
  windowStartedAt: number;
  emitted: boolean;
  suppressed: number;
}

export interface SecurityLogOptions {
  readonly now?: () => number;
  readonly windowMillis?: number;
  readonly sink?: SecurityLogSink;
}

const DEFAULT_WINDOW_MILLIS = 5_000;
/** A defence in depth bound: even a caller bug cannot grow this map without limit. */
const MAX_TRACKED_KEYS = 256;

const REASONS: readonly string[] = [
  'rate_limited',
  'redis_unavailable',
  'argon2id_saturated',
  'argon2id_unavailable',
  'token_rejected',
  'event_write_failed',
  'unhandled_error',
];

function sanitizedReason(value: unknown): SecurityLogReason | undefined {
  return typeof value === 'string' && REASONS.includes(value)
    ? (value as SecurityLogReason)
    : undefined;
}

function sanitizedCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    return undefined;
  }
  return value;
}

/**
 * Throttled structured security log.
 *
 * One instance per process. Deliberately dependency-free and Redis-free: two of the conditions it records
 * are Redis being unavailable, so using the shared Redis client to record them would mean the recorder
 * fails exactly when it is needed. Per-process state also means throttle state is not shared across
 * replicas, which is acceptable because the bound is a per-replica disk bound rather than a correctness
 * property.
 */
export class SecurityLog {
  private readonly now: () => number;
  private readonly windowMillis: number;
  private readonly sink: SecurityLogSink;
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(options: SecurityLogOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.windowMillis = options.windowMillis ?? DEFAULT_WINDOW_MILLIS;
    this.sink = options.sink ?? defaultSink;
  }

  /**
   * Sanitise, throttle, and emit one security record.
   *
   * Never throws: a logging failure must not convert a completed authentication into an error response,
   * and must not mask the original outcome.
   */
  record(kind: unknown, fields: SecurityLogFields = {}): void {
    try {
      const sanitized = sanitizeSecurityFields(fields);
      const key = `${String(kind)}:${sanitized.endpoint ?? '-'}`;
      const time = this.now();
      const previous = this.entries.get(key);

      if (previous === undefined || time - previous.windowStartedAt >= this.windowMillis) {
        if (previous !== undefined && previous.suppressed > 0) {
          // One aggregate line for everything the throttle absorbed, so a sustained flood is visible as
          // a count rather than silently dropped.
          this.emit({
            kind: 'security_log_suppressed',
            ...(sanitized.endpoint === undefined ? {} : { endpoint: sanitized.endpoint }),
            suppressed: previous.suppressed,
            ...(sanitized.reason === undefined ? {} : { reason: sanitized.reason }),
            ...(sanitized.requestId === undefined ? {} : { requestId: sanitized.requestId }),
          });
        }
        this.remember(key, { windowStartedAt: time, emitted: true, suppressed: 0 });
        this.emit({ kind: String(kind), ...sanitized });
        return;
      }

      previous.suppressed += 1;
      this.entries.set(key, previous);
    } catch {
      // A logger that throws is a bug, but it must not become an outage.
    }
  }

  private remember(key: string, entry: ThrottleEntry): void {
    if (this.entries.size >= MAX_TRACKED_KEYS && !this.entries.has(key)) {
      // Evict the oldest window rather than grow without bound.
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [candidate, value] of this.entries) {
        if (value.windowStartedAt < oldest) {
          oldest = value.windowStartedAt;
          oldestKey = candidate;
        }
      }
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, entry);
  }

  private emit(record: SanitizedSecurityRecord): void {
    try {
      this.sink(record);
    } catch {
      // Never let diagnostics break a request.
    }
  }
}

/**
 * Drop anything outside the allowlist.
 *
 * This is a structural filter over a *closed* set of fields, not a regular expression scrubbing a string
 * it hopes to recognise. A caller that invents a field gets it dropped, because `sanitized` is built from
 * scratch here rather than by mutating the input.
 */
export function sanitizeSecurityFields(
  fields: SecurityLogFields,
): Omit<SanitizedSecurityRecord, 'kind'> {
  const requestId = sanitizedUuid(fields.requestId);
  const endpoint = securityEndpointOf(fields.endpoint);
  const userId = sanitizedUuid(fields.userId);
  const reason = sanitizedReason(fields.reason);
  const count = sanitizedCount(fields.count);
  const suppressed = sanitizedCount(fields.suppressed);
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(userId === undefined ? {} : { userId }),
    ...(reason === undefined ? {} : { reason }),
    ...(count === undefined ? {} : { count }),
    ...(suppressed === undefined ? {} : { suppressed }),
  };
}

/**
 * Default sink: one JSON object per line on stderr.
 *
 * stderr rather than stdout so a line can never be interleaved into a response body by a proxy that
 * merges the streams. `JSON.stringify` on the already-sanitised record cannot throw, because every value
 * is a string or a bounded integer.
 */
function defaultSink(record: SanitizedSecurityRecord): void {
  console.error(JSON.stringify({ event: 'security', ...record }));
}
