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

  // The sustained rate of the postback tier, per API key. Postbacks get their
  // own bucket because a Black Friday spike is legitimate traffic and must not
  // be throttled alongside the dashboard.
  //
  // Was 1000, which was never enforced per key -- the old limiter counted
  // every caller into one in-memory total, so the number described nothing.
  // 100/minute bursting to 200 is the story's figure and is now what a single
  // brand actually gets.
  POSTBACK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(100),

  // Where creative uploads are written. Local disk for now; the ObjectStorage
  // interface in lib/storage.ts is the seam for moving to S3.
  ASSET_STORAGE_PATH: z.string().default("./storage/assets"),

  /**
   * Lets outbound webhooks reach private addresses.
   *
   * Off by default, and it must stay off in any environment reachable from the
   * internet: a webhook url is an address a stranger chooses and this server
   * dials, which is the SSRF primitive in its purest form. It exists because
   * an integration test's stub server is on loopback by definition, and a
   * suite that cannot exercise the real socket cannot prove the timeout works.
   *
   * Registration validates the url regardless of this flag, so turning it on
   * does not open the API -- only the delivery-time address check relaxes.
   */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: boolFromString(false),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
