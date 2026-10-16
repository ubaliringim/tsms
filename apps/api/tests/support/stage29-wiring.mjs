// Wiring for tests that build the identity services directly instead of through `createApplication`.
//
// Stage 2.9 made two collaborators required: the Argon2id admission service carries the global workload budget it
// charges when it admits an operation, and the authentication service carries the per-account success meter. Both
// are backed by the real Redis scripts, so a test built this way exercises the same budgets production does.
import { AbuseProtectionService } from '../../dist/identity/abuse-protection.service.js';
import { Argon2idAdmissionService } from '../../dist/identity/argon2id-admission.service.js';
import { ARGON2ID_CONCURRENCY } from '../../dist/identity/auth-abuse-policy.js';

const SECRET = 'stage29_direct_wiring_rate_limit_key_0123456789ab';

const protectionFor = (redis, secret = SECRET) => new AbuseProtectionService({ secret, redis });

/** The real Argon2id admission service, with the real global workload budget behind it. */
export function admissionFor(redis, secret = SECRET) {
  const protection = protectionFor(redis, secret);
  return new Argon2idAdmissionService(
    redis,
    { charge: () => protection.chargeGlobalWorkload() },
    ARGON2ID_CONCURRENCY,
  );
}

/** The real per-account success meter. */
export function successMeterFor(redis, secret = SECRET) {
  const protection = protectionFor(redis, secret);
  return {
    charge: (email) => protection.chargeLoginSuccess(email),
    refund: (email) => protection.refundLoginSuccess(email),
  };
}
