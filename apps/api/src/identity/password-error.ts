export type PasswordErrorCode =
  | 'INVALID_PASSWORD'
  | 'HASH_FAILURE'
  | 'VERIFICATION_FAILURE'
  | 'USER_NOT_FOUND'
  | 'CREDENTIAL_EXISTS'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CONCURRENT_CHANGE'
  | 'PERSISTENCE_FAILURE';

/** Fixed messages only: never attach passwords, hashes, driver errors, or causes. */
export class PasswordCredentialError extends Error {
  constructor(readonly code: PasswordErrorCode) {
    super(code);
    this.name = 'PasswordCredentialError';
  }
}
