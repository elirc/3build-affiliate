import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { boolFromString } from './env-parsers';

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

  /**
   * Identifies this process in logs and in scheduler leases.
   *
   * Generated when absent so a local run works without configuration, but a
   * deployment should set it to something meaningful (a pod name, a task ARN)
   * -- when a lease is stuck, the first question is who holds it, and a random
   * id can only tell you "not me".
   */
  INSTANCE_ID: z.string().min(1).default(randomUUID()),

  // Shared secret for service-to-service calls from the redirect service.
  // Not a user credential: it authenticates a deployable, not a person.
  INTERNAL_API_TOKEN: z.string().min(20),

  // 32 bytes of hex. Encrypts campaign postback secrets at rest -- they must
  // be recoverable to verify HMAC signatures, so they cannot be hashed.
  // Rotating this makes every existing campaign API key undecryptable, so it
  // belongs in a secret manager, not in a deploy script.
  POSTBACK_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),

  // POSTBACK_RATE_LIMIT_PER_MINUTE used to live here. Rate limits are now a
  // table of four tiers in lib/rate-limiter.ts: one tier being tunable from
  // the environment while the other three were hard-coded was a trap, because
  // the number you could see was not the policy you had.

  // Where creative uploads are written. Local disk for now; the ObjectStorage
  // interface in lib/storage.ts is the seam for moving to S3.
  ASSET_STORAGE_PATH: z.string().default("./storage/assets"),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
