import { z } from 'zod';

/**
 * Environment variables are always strings. `z.coerce.boolean()` runs
 * `Boolean(value)`, and every non-empty string is truthy -- including the
 * string "false". Any flag written that way is on whenever it is set at all,
 * which is the opposite of what the reader expects.
 *
 * This parses the two spellings a human would actually write, and rejects
 * anything else loudly at boot rather than guessing.
 */
export const boolFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(20),
  JWT_REFRESH_SECRET: z.string().min(20),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(50).default(5),
  DISABLE_WORKERS: boolFromString(false),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
