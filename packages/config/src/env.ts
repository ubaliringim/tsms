import { z } from 'zod';

const mode = z.enum(['development', 'test', 'production']).default('development');
const host = z.string().trim().min(1).default('127.0.0.1');
const port = (fallback: string) =>
  z
    .string()
    .regex(/^\d+$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535));

/**
 * Database and Redis URLs are validated for shape and protocol here, but they
 * carry credentials. Error reporting below therefore names keys only and never
 * echoes a supplied value.
 *
 * `parseUrl` is defensive on purpose: Zod runs refinement checks even after an
 * earlier check has failed, so `new URL()` must never be called unguarded.
 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const databaseUrl = z
  .url()
  .refine((value) => {
    const parsed = parseUrl(value);
    return (
      parsed !== null && (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:')
    );
  }, 'must be a PostgreSQL connection URL')
  .refine((value) => (parseUrl(value)?.pathname.replace(/^\//, '') ?? '') !== '', {
    message: 'must include a database name',
  });

const redisUrl = z.url().refine((value) => {
  const parsed = parseUrl(value);
  return parsed !== null && (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:');
}, 'must be a Redis connection URL');

/**
 * Browser origins allowed to make cookie-authenticated requests, as a comma-separated list.
 *
 * The Stage 2.4 Origin check must never fall back to a request-supplied `Host` or
 * `X-Forwarded-Host`, so the trusted set has to come from validated configuration. It is
 * required in every environment: an empty or absent allowlist is a fail-closed API, not a
 * permissive default.
 *
 * Each entry must be a bare absolute origin. Credentials, a path, a query, or a fragment are
 * rejected so that a broader-looking value cannot quietly widen the allowlist. Entries are
 * normalised to `URL.origin`, which lower-cases the host and drops default ports, so two spellings
 * of one origin collapse to a single entry and are then rejected as a duplicate rather than
 * compared inconsistently.
 *
 * Host characters are checked explicitly. `new URL` accepts `*` and `,` inside a host, so
 * `https://*.example.com` and a comma-joined pair both parse into a nonsense host and would
 * otherwise be stored as a trusted origin that can never match a real `Origin` header. Failing at
 * startup turns a silent misconfiguration into a visible one, and keeps a wildcard out of the
 * allowlist entirely so a later suffix-matching change could never find one waiting there.
 */
function parseTrustedOrigins(value: string): string[] | null {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return null;
  const origins: string[] = [];
  for (const entry of entries) {
    const parsed = parseUrl(entry);
    if (
      parsed === null ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.host === '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      /[*,\s]/.test(parsed.host)
    ) {
      return null;
    }
    origins.push(parsed.origin);
  }
  return new Set(origins).size === origins.length ? origins : null;
}

const apiTrustedOrigins = z
  .string()
  .refine((value) => parseTrustedOrigins(value) !== null, {
    message:
      'must be a comma-separated list of unique absolute http or https origins without credentials, path, query, or fragment',
  })
  .transform((value) => parseTrustedOrigins(value) as string[]);

/**
 * Base URL that password-recovery links are built from - Stage 2.5.
 *
 * The recovery URL is emailed to the account owner, so a value derived from a request header would
 * let an attacker point a victim at a host they control. This must come from validated configuration.
 * Only an absolute http or https URL with no credentials, query, or fragment is accepted, and the
 * wildcard host characters rejected for origins are rejected here too.
 */
const passwordRecoveryUrlBase = z
  .string()
  .min(1)
  .refine((value) => {
    const parsed = parseUrl(value);
    return (
      parsed !== null &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      !/[*,\s]/.test(parsed.host)
    );
  }, 'must be an absolute http or https URL without credentials, query, or fragment');

/**
 * Delivery availability for password recovery - Stage 2.5.
 *
 * No real mail provider is authorized, so delivery is explicit rather than an implicit default.
 * `disabled` is the default and fails the recovery endpoints closed. `development-only` uses the
 * in-memory adapter and is refused outright under production, so the public recovery workflow cannot
 * be enabled without real delivery by changing an environment variable alone.
 */
const passwordRecoveryDeliveryMode = z.enum(['disabled', 'development-only']);

/**
 * Secret for deriving rate-limit keys - Stage 2.6.
 *
 * Keys must not contain raw addresses, recovery tokens, or session tokens, so every subject is
 * reduced to an HMAC before it reaches Redis. This is that HMAC key.
 *
 * It is deliberately *not* authentication material: it never signs a session, never authorises a
 * request, and is never sent to a client. It is required in every environment because a deployment
 * that cannot derive stable keys cannot enforce a distributed limit at all, and silently falling
 * back to process-local counters would recreate the gap Stage 2.6 exists to close.
 *
 * Length is bounded at both ends. Too short and an attacker who reads a Redis key could brute-force
 * candidate addresses; too long and there is no operational benefit. Rejecting a value that matches
 * a known placeholder keeps a copy-pasted development string from becoming a production key.
 */
const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'changeme',
  'placeholder',
  'example',
  'secret',
  'test',
]);

/**
 * Reject a value whose characters are effectively one repeated symbol.
 *
 * A length check alone does not establish a secret: `'x'.repeat(32)` passes any minimum-length rule and
 * carries almost no entropy, so anyone who guessed the pattern could derive every rate-limit key.
 *
 * This is deliberately narrow. It catches the single-value case and short alternating runs, which are the
 * shapes a length rule misses and which appear in practice when a value is padded to satisfy validation.
 * It is **not** a claim to measure entropy, and it cannot be: real entropy comes from the generator that
 * produced the value, not from inspecting it. That remains an operator responsibility, recorded as a
 * deployment requirement.
 */
function hasTrivialCharacterStructure(value: string): boolean {
  if (new Set(value).size < 8) return true;
  // A short cycle repeated to length, such as 'abcdabcd...'.
  for (let period = 1; period <= 4; period += 1) {
    const pattern = value.slice(0, period);
    if (pattern.length < period) continue;
    if (value === pattern.repeat(Math.ceil(value.length / period)).slice(0, value.length))
      return true;
  }
  return false;
}

const rateLimitHmacSecret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .max(512, 'must be at most 512 characters')
  .refine((value) => /^[A-Za-z0-9_-]+$/.test(value), {
    message: 'must contain only letters, digits, underscore, or hyphen',
  })
  .refine((value) => !PLACEHOLDER_SECRETS.has(value.toLowerCase()), {
    message: 'must not be a placeholder value',
  })
  .refine((value) => !hasTrivialCharacterStructure(value), {
    message: 'must not be a single repeated character or a short repeating pattern',
  });

const apiSchema = z
  .object({
    NODE_ENV: mode,
    API_HOST: host,
    API_PORT: port('4000'),
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    API_TRUSTED_ORIGINS: apiTrustedOrigins,
    API_PASSWORD_RECOVERY_URL_BASE: passwordRecoveryUrlBase.optional(),
    API_PASSWORD_RECOVERY_DELIVERY_MODE: passwordRecoveryDeliveryMode.default('disabled'),
    API_RATE_LIMIT_HMAC_SECRET: rateLimitHmacSecret,
  })
  // A recovery URL is only meaningful when something can deliver it, and delivery in production
  // needs a real provider this stage does not have. Both are startup failures, not runtime surprises.
  .superRefine((value, context) => {
    if (
      value.API_PASSWORD_RECOVERY_DELIVERY_MODE !== 'disabled' &&
      !value.API_PASSWORD_RECOVERY_URL_BASE
    ) {
      context.addIssue({
        code: 'custom',
        path: ['API_PASSWORD_RECOVERY_URL_BASE'],
        message: 'is required when delivery mode is enabled',
      });
    }
    if (
      value.NODE_ENV === 'production' &&
      value.API_PASSWORD_RECOVERY_DELIVERY_MODE === 'development-only'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['API_PASSWORD_RECOVERY_DELIVERY_MODE'],
        message: 'may not be development-only in production',
      });
    }
  });
const workerSchema = z.object({
  NODE_ENV: mode,
  WORKER_HOST: host,
  WORKER_HEALTH_PORT: port('4001'),
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
});

/**
 * Integration tests run against a separate disposable database and a separate
 * non-default Redis logical database. Requiring them explicitly keeps a stray
 * `DATABASE_URL` from being used by destructive test setup.
 */
const integrationSchema = z.object({
  NODE_ENV: z.literal('test'),
  TEST_DATABASE_URL: databaseUrl,
  TEST_REDIS_URL: redisUrl,
});

function parse<T>(schema: z.ZodType<T>, input: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Report keys only: invalid values may eventually contain credentials.
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${keys.join(', ')}`);
  }
  return result.data;
}

export type ApiEnvironment = z.infer<typeof apiSchema>;
export type WorkerEnvironment = z.infer<typeof workerSchema>;
export type IntegrationEnvironment = z.infer<typeof integrationSchema>;

export const parseApiEnvironment = (input: NodeJS.ProcessEnv) => parse(apiSchema, input);
export const parseWorkerEnvironment = (input: NodeJS.ProcessEnv) => parse(workerSchema, input);
export const parseIntegrationEnvironment = (input: NodeJS.ProcessEnv) =>
  parse(integrationSchema, input);
