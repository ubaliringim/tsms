import { RECOVERY_POLICY } from './password-recovery-token.js';

/** What a delivery adapter is given, and nothing more. */
export interface RecoveryInstructions {
  /** Destination address, taken from the stored `User.email`. */
  readonly recipient: string;
  /** Display name, for a human-readable greeting only. */
  readonly displayName: string;
  /**
   * The raw recovery token.
   *
   * It is transiently available here and to the reset-URL builder, and to nothing else. It must not
   * be logged, stored, returned in an HTTP response, or attached to telemetry or an exception.
   */
  readonly token: string;
  /** Absolute reset URL. Never derived from a request header. */
  readonly resetUrl: string;
  /** Absolute expiry, so a real provider can state a deadline. */
  readonly expiresAt: Date;
}

/**
 * Internal delivery port for password recovery - Stage 2.5.
 *
 * Deliberately narrow: no HTTP shape, no provider SDK, no credentials. A future authorized stage
 * implements this against a real mail service. An implementation must not log `token` or `resetUrl`.
 */
export interface PasswordRecoveryDelivery {
  /** Resolve when the instructions have been handed off, or reject on failure. */
  sendRecoveryInstructions(instructions: RecoveryInstructions): Promise<void>;
}

export type RecoveryDeliveryMode = 'disabled' | 'development-only';

/**
 * A delivery adapter that refuses every request.
 *
 * This is the production-safe default. Selecting it means password recovery is unavailable, and the
 * service fails closed *before* creating a token, so no state changes and no email is attempted.
 */
export class DisabledRecoveryDelivery implements PasswordRecoveryDelivery {
  sendRecoveryInstructions(): Promise<void> {
    return Promise.reject(new Error('Password recovery delivery is disabled.'));
  }
}

/**
 * In-memory development and test adapter.
 *
 * Records what it was asked to send so a test can assert on it, and holds the token only in process
 * memory. It writes nothing to stdout, a logger, a file, or the database, because the accepted
 * operating rule is that a token must never reach an operational channel. Configuration validation
 * refuses to select this under `NODE_ENV=production`.
 */
export class InMemoryRecoveryDelivery implements PasswordRecoveryDelivery {
  private readonly sent: RecoveryInstructions[] = [];

  async sendRecoveryInstructions(instructions: RecoveryInstructions): Promise<void> {
    this.sent.push(instructions);
  }

  /** Everything this adapter was asked to send, for assertions. */
  get deliveries(): readonly RecoveryInstructions[] {
    return this.sent;
  }

  /** Most recent delivery, for assertions. Throws when nothing was sent. */
  get last(): RecoveryInstructions {
    const latest = this.sent.at(-1);
    if (latest === undefined) throw new Error('No recovery delivery was recorded.');
    return latest;
  }

  /** Forget every recorded delivery. */
  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Build the adapter for a validated delivery mode.
 *
 * `disabled` fails the recovery workflow closed. `development-only` uses the in-memory adapter, which
 * configuration has already refused to allow under production.
 */
export function recoveryDeliveryFor(mode: RecoveryDeliveryMode): PasswordRecoveryDelivery {
  return mode === 'development-only'
    ? new InMemoryRecoveryDelivery()
    : new DisabledRecoveryDelivery();
}

/** Whether this mode can deliver at all. */
export function deliveryAvailable(mode: RecoveryDeliveryMode): boolean {
  return mode === 'development-only';
}

/** True when the mode uses the in-memory adapter, whose deliveries a test can inspect. */
export function isInspectableDelivery(
  delivery: PasswordRecoveryDelivery,
): delivery is InMemoryRecoveryDelivery {
  return delivery instanceof InMemoryRecoveryDelivery;
}

export { RECOVERY_POLICY };
