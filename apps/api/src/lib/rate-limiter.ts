import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { bucketSpec, type TokenBucketSpec } from '@affiliate/analytics';
import { redis as sharedRedis } from '../config/redis';
import { env } from '../config/env';

/**
 * A token bucket that every API instance shares.
 *
 * The limiter this replaces was `@fastify/rate-limit` with an in-memory store,
 * which has two problems that no amount of tuning fixes. It counted per
 * process, so two instances meant the effective limit was double the one
 * configured and a restart reset it. And it counted globally, so one brand's
 * runaway postback script consumed the budget of every other tenant. A limit
 * that is neither the number you wrote down nor scoped to the thing you wanted
 * to isolate is not really a limit.
 *
 * ## Why Lua
 *
 * Refilling a bucket is read-modify-write. Done from the application it is a
 * lost update: two requests read one remaining token, both decrement, both
 * proceed, and the limit is whatever concurrency happens to be. Redis runs a
 * Lua script atomically, so the read, the refill, the test and the write are
 * one indivisible step. This is the same reason `lib/lease.ts` is Lua.
 *
 * ## Why EVALSHA
 *
 * `EVAL` ships the whole script on every request. `EVALSHA` sends 40 bytes and
 * lets Redis look it up -- but the cache is lost on restart or `SCRIPT FLUSH`,
 * so `NOSCRIPT` has to fall back to `EVAL`, which also re-caches it. Optimistic
 * first, correct on the miss.
 */

/**
 * Mirrors `consume` in `@affiliate/analytics/token-bucket`. The maths is
 * pinned by unit tests there; this is the atomic transcription of it, and the
 * two are expected to agree token for token.
 *
 * State is a hash rather than two keys so that a bucket is one round trip and
 * one expiry, and so `tokens` and `ts` can never be written apart.
 */
const CONSUME_SCRIPT = `
local capacity   = tonumber(ARGV[1])
local per_minute = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])
local ttl        = tonumber(ARGV[5])

local stored = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(stored[1])
local ts     = tonumber(stored[2])

-- No bucket, or one that expired while idle. Either way the client is owed a
-- full burst: an expired bucket would have refilled to capacity anyway.
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

-- Only ever move forwards. A clock that jumped backwards must not subtract
-- tokens from a client that did nothing wrong.
if now > ts then
  tokens = math.min(capacity, tokens + (now - ts) * per_minute / 60000)
  ts = now
end

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call("HSET", KEYS[1], "tokens", tokens, "ts", ts)
redis.call("PEXPIRE", KEYS[1], ttl)

-- Durations are derived as \`tokens * 60000 / per_minute\` rather than from a
-- pre-divided per-millisecond rate: 10 a minute is exactly one every 6000ms
-- this way, and 6000.000000000000333 the other, which rounds up to a
-- Retry-After of 7 seconds on a limit whose period is 6. The epsilon covers
-- what is left of the same problem.
local function period_ms(t)
  return math.ceil(t * 60000 / per_minute - 1e-9)
end

local retry_after_ms = 0
if allowed == 0 then
  retry_after_ms = period_ms(cost - tokens)
end

-- Lua numbers cross the Redis protocol as integers, so the fractional token
-- balance is floored here deliberately rather than truncated by accident.
return { allowed, math.floor(tokens), retry_after_ms, period_ms(capacity - tokens) }
`;

const CONSUME_SHA = createHash('sha1').update(CONSUME_SCRIPT).digest('hex');

/** What a bucket is keyed by, and therefore what one noisy client can spend. */
export type RateLimitScope = 'apiKey' | 'user' | 'ip';

export interface RateLimitPolicy {
  /** Sustained rate. */
  perMinute: number;
  /** Largest burst tolerated in one instant. */
  burst: number;
  scope: RateLimitScope;
  /**
   * What to do when Redis cannot answer. See `plugins/rate-limit.ts` -- this
   * is an availability-versus-security decision and it is different for
   * different endpoints.
   */
  failOpen: boolean;
}

/**
 * The tiers, as policy rather than as scattered constants.
 *
 * The numbers differ because the traffic differs, not because anyone tuned
 * until the alerts stopped:
 *
 * - Postbacks are machine traffic from a storefront and are keyed per API key,
 *   because storefronts share egress IPs behind NAT and serverless platforms
 *   and one brand must never be able to throttle another.
 * - The authenticated API is a person clicking, keyed per user, generous
 *   enough that a dashboard opening eight panels at once is never throttled.
 * - Auth endpoints are the brute-force surface. Ten a minute per IP is
 *   uncomfortable for an attacker and invisible to anyone who can type.
 * - Public endpoints get an IP bucket because there is nothing better to key
 *   on, with all the coarseness that implies for shared IPs.
 */
export const RATE_LIMIT_TIERS = {
  postback: {
    // Configurable because a brand's Black Friday is a real event and someone
    // will need to raise this at 2am without a deploy.
    perMinute: env.POSTBACK_RATE_LIMIT_PER_MINUTE,
    burst: 200,
    scope: 'apiKey',
    failOpen: true,
  },
  authenticated: { perMinute: 300, burst: 500, scope: 'user', failOpen: true },
  auth: { perMinute: 10, burst: 15, scope: 'ip', failOpen: false },
  public: { perMinute: 60, burst: 100, scope: 'ip', failOpen: true },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

export interface RateLimitDecision {
  allowed: boolean;
  /** `X-RateLimit-Limit`: the burst ceiling, not the per-minute rate. */
  limit: number;
  /** `X-RateLimit-Remaining`: whole tokens still spendable. */
  remaining: number;
  /** Seconds until one token exists. Zero when allowed. */
  retryAfterSeconds: number;
  /** `X-RateLimit-Reset`: seconds until the bucket is back at its ceiling. */
  resetSeconds: number;
}

export interface RateLimiter {
  consume(bucket: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

/**
 * How long an untouched bucket survives.
 *
 * Long enough to outlive a full refill, because a bucket dropped while it is
 * still below capacity hands the client back its whole burst. Beyond that
 * point the bucket is full and forgetting it costs nothing, so the extra
 * minute is only slack for a slow clock.
 */
function ttlMs(spec: TokenBucketSpec): number {
  return Math.ceil((spec.capacity / spec.refillPerSecond) * 1000) + 60_000;
}

/**
 * The script returns a four-element array of integers. `evalsha` is typed as
 * `unknown` because a Lua script can return anything; the shape is fixed by
 * the `return` at the bottom of `CONSUME_SCRIPT` and nothing else calls this.
 */
type ConsumeReply = [allowed: number, remaining: number, retryMs: number, resetMs: number];

function toDecision(raw: unknown, spec: TokenBucketSpec): RateLimitDecision {
  const [allowed, remaining, retryAfterMs, resetMs] = raw as ConsumeReply;
  return {
    allowed: allowed === 1,
    limit: spec.capacity,
    remaining,
    // Rounded up, and never below one: `Retry-After: 0` invites an immediate
    // retry that is certain to be rejected again.
    retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
    resetSeconds: Math.ceil(resetMs / 1000),
  };
}

/**
 * Binds the script to a Redis connection.
 *
 * A factory rather than a module singleton so that tests can point two
 * limiters at one Redis and prove the budget is genuinely shared, and point a
 * third at a dead one to exercise the failure path.
 */
export function createRateLimiter(client: Redis): RateLimiter {
  return {
    async consume(bucket, policy) {
      const spec = bucketSpec(policy.perMinute, policy.burst);
      const args = [
        String(spec.capacity),
        String(policy.perMinute),
        String(Date.now()),
        '1',
        String(ttlMs(spec)),
      ];

      try {
        return toDecision(await client.evalsha(CONSUME_SHA, 1, bucket, ...args), spec);
      } catch (err) {
        // Only NOSCRIPT is ours to handle. A connection error has to reach the
        // caller so it can make the fail-open decision knowingly, rather than
        // being silently converted into an allow here.
        if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
        return toDecision(await client.eval(CONSUME_SCRIPT, 1, bucket, ...args), spec);
      }
    },
  };
}

/**
 * The bucket key.
 *
 * `name` is the policy the request was judged under, so a route with its own
 * tighter limit gets its own bucket rather than sharing the tier's. Two
 * policies keyed on the same user would otherwise silently drain each other.
 */
export function bucketKey(name: string, scope: RateLimitScope, id: string): string {
  return `ratelimit:${name}:${scope}:${id}`;
}

export const rateLimiter = createRateLimiter(sharedRedis);
