import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { refillRatePerMs, type TokenBucketPolicy } from '@affiliate/analytics';
import { redis as sharedRedis } from '../config/redis';
import { logger } from './logger';

/**
 * A token bucket per caller, held in Redis so every instance shares it.
 *
 * ## Why Redis and not memory
 *
 * The limiter this replaces counted in the process. Two instances therefore
 * enforced twice the configured limit, three enforced three times, and a deploy
 * reset every counter to zero. A limit that changes with the replica count is
 * not a limit, it is a coincidence.
 *
 * ## Why Lua and not GET/SET
 *
 * Refilling a bucket is read-modify-write. Done from the application, two
 * requests read the same one remaining token, both decrement it, and both
 * proceed -- the classic lost update, and it appears precisely under the load
 * the limiter exists for. Redis runs a script atomically, so the read, the
 * refill and the decrement cannot interleave with anybody else's.
 *
 * ## Why EVALSHA first
 *
 * `EVAL` ships the whole script on every request. `EVALSHA` ships 40 bytes and
 * Redis looks it up in its script cache. The cache does not survive a restart
 * or a `SCRIPT FLUSH`, so `NOSCRIPT` is not an error -- it is the signal to
 * send the body once more, which reloads it.
 */

/**
 * A transliteration of `consume()` in `packages/analytics/src/token-bucket.ts`.
 * Change one, change the other; the integration suite asserts they agree.
 *
 * The clock comes from `TIME` rather than from the caller. Every instance
 * reads the same clock that way, so a host whose NTP has drifted cannot mint
 * itself extra budget by claiming that more time has passed than really has.
 * (Redis has replicated scripts by effect since 5.0, so a non-deterministic
 * command inside one is no longer a replication hazard.)
 */
const BUCKET_SCRIPT = `
local capacity     = tonumber(ARGV[1])
local refill_per_ms= tonumber(ARGV[2])
local cost         = tonumber(ARGV[3])
local ttl_ms       = tonumber(ARGV[4])

local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

local stored = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(stored[1])
local last   = tonumber(stored[2])

if tokens == nil or last == nil then
  -- Unseen caller: start full, so the first request of a new API key is not a
  -- 429.
  tokens = capacity
  last = now
end

-- Clamped at zero. A clock that reads earlier than the last write must not be
-- able to remove tokens.
local elapsed = math.max(0, now - last)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retry_after_ms = math.ceil((cost - tokens) / refill_per_ms)
end

redis.call("HSET", KEYS[1], "tokens", tokens, "ts", now)
-- Expiry is the garbage collector: a caller seen once must not occupy memory
-- for ever. It has to outlive a full refill, because an idle bucket that
-- expires early comes back full -- which would hand a throttled caller its
-- whole burst again the moment it paused.
redis.call("PEXPIRE", KEYS[1], ttl_ms)

local reset_ms = math.ceil((capacity - tokens) / refill_per_ms)

-- Lua numbers cross back as integers, so anything fractional must be floored
-- here rather than silently truncated on the way out.
return { allowed, math.floor(tokens), retry_after_ms, reset_ms }
`;

/** Redis keys its script cache by the SHA-1 of the body, so we can precompute it. */
const BUCKET_SCRIPT_SHA = createHash('sha1').update(BUCKET_SCRIPT).digest('hex');

/** What a budget is counted against. */
export type RateLimitScope = 'apiKey' | 'user' | 'ip';

export interface TierPolicy extends TokenBucketPolicy {
  scope: RateLimitScope;
  /**
   * What to do when Redis cannot be reached.
   *
   * `true` admits the request: for ordinary traffic a limiter outage must not
   * become an API outage. `false` rejects it: on the credential endpoints the
   * limit *is* the brute-force control, and serving unlimited login attempts
   * because a cache is down trades a security guarantee for an availability
   * one that nobody agreed to.
   */
  failOpen: boolean;
}

export type RateLimitTier = 'postback' | 'authenticated' | 'auth' | 'public';

/**
 * The four budgets, in one place on purpose.
 *
 * These were previously one global `max: 200` shared by every tenant, so one
 * brand's misbehaving postback script could exhaust the budget for everybody.
 * Scoping is the whole point: a limit is only meaningful against the thing you
 * want to isolate.
 */
export const TIERS: Record<RateLimitTier, TierPolicy> = {
  // Per API key. Machine traffic with a legitimate sale spike behind it, so
  // the burst is twice the sustained rate.
  postback: { perMinute: 100, burst: 200, scope: 'apiKey', failOpen: true },
  // Per user. A dashboard page fans out to several endpoints at once, which is
  // what the burst is for.
  authenticated: { perMinute: 300, burst: 500, scope: 'user', failOpen: true },
  // Per IP, and deliberately small: this is the brute-force control on the
  // endpoints that accept a password.
  auth: { perMinute: 10, burst: 15, scope: 'ip', failOpen: false },
  // Per IP, for anything reachable without a credential.
  public: { perMinute: 60, burst: 100, scope: 'ip', failOpen: true },
};

export interface RateLimitResult {
  allowed: boolean;
  /** `X-RateLimit-Limit`: the burst, which is the most you can spend at once. */
  limit: number;
  /** `X-RateLimit-Remaining`: whole tokens left. */
  remaining: number;
  /** `Retry-After`, in seconds. At least 1 when rejected -- 0 means "now". */
  retryAfterSeconds: number;
  /** `X-RateLimit-Reset`: seconds until the bucket is full again. */
  resetSeconds: number;
  /** True when Redis was unreachable and the tier's fallback decided. */
  degraded: boolean;
}

/** Namespaced so a `FLUSHDB` in a test, or a scan in production, is legible. */
export function bucketKey(tier: RateLimitTier, subject: string): string {
  return `ratelimit:${tier}:${subject}`;
}

/**
 * Spends one token from `key`, or reports that there were none.
 *
 * `client` is injectable so a test can point a second connection at the same
 * Redis and prove the budget really is shared rather than per-process.
 */
export async function consumeToken(
  key: string,
  policy: TierPolicy,
  client: Redis = sharedRedis
): Promise<RateLimitResult> {
  const ratePerMs = refillRatePerMs(policy);
  // Two full refills. One would be the theoretical minimum; the margin means
  // a bucket that is being spent down slowly is never collected mid-throttle.
  const ttlMs = Math.ceil((policy.burst / ratePerMs) * 2);
  const args = [String(policy.burst), String(ratePerMs), '1', String(ttlMs)];

  try {
    const raw = await evalBucketScript(client, key, args);
    const [allowed, remaining, retryAfterMs, resetMs] = raw;

    return {
      allowed: allowed === 1,
      limit: policy.burst,
      remaining,
      // Round up, and never to zero: a client told to retry in 0 seconds
      // retries immediately and is rejected again, which is the hammering the
      // header exists to prevent.
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
      resetSeconds: Math.ceil(resetMs / 1000),
      degraded: false,
    };
  } catch (err) {
    logger.error(
      { err, key, scope: policy.scope, failOpen: policy.failOpen },
      'Rate limiter could not reach Redis; falling back to the tier default'
    );

    return {
      allowed: policy.failOpen,
      limit: policy.burst,
      // Nothing is known about this caller's budget, and inventing a number
      // would be worse than reporting the whole one.
      remaining: policy.failOpen ? policy.burst : 0,
      retryAfterSeconds: policy.failOpen ? 0 : 1,
      resetSeconds: 0,
      degraded: true,
    };
  }
}

/** The four integers the script returns. */
type BucketReply = [number, number, number, number];

async function evalBucketScript(
  client: Redis,
  key: string,
  args: string[]
): Promise<BucketReply> {
  try {
    return (await client.evalsha(BUCKET_SCRIPT_SHA, 1, key, ...args)) as BucketReply;
  } catch (err) {
    // Not a failure: the script cache is empty after a restart or a SCRIPT
    // FLUSH. Sending the body reloads it, and the next request is an EVALSHA
    // again. Anything else -- a connection error, a script bug -- is rethrown
    // so the caller's fail-open/closed decision gets to make it.
    if (!isNoScriptError(err)) throw err;
    return (await client.eval(BUCKET_SCRIPT, 1, key, ...args)) as BucketReply;
  }
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}
