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

const apiSchema = z.object({
  NODE_ENV: mode,
  API_HOST: host,
  API_PORT: port('4000'),
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
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
