export type SessionErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TOKEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'USER_NOT_FOUND'
  | 'USER_DISABLED'
  | 'SERVICE_FAILURE';

/** Internal classifications only; future HTTP adapters must collapse credential failures. */
export class SessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(code);
    this.name = 'SessionError';
  }
}
