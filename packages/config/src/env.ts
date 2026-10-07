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

const apiSchema = z.object({
  NODE_ENV: mode,
  API_HOST: host,
  API_PORT: port('4000'),
});
const workerSchema = z.object({
  NODE_ENV: mode,
  WORKER_HOST: host,
  WORKER_HEALTH_PORT: port('4001'),
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

export const parseApiEnvironment = (input: NodeJS.ProcessEnv) => parse(apiSchema, input);
export const parseWorkerEnvironment = (input: NodeJS.ProcessEnv) => parse(workerSchema, input);
