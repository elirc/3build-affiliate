/**
 * Token bucket arithmetic.
 *
 * A bucket of capacity `burst` refills at `perMinute / 60000` tokens per
 * millisecond. A request costs one token; no token means reject. That single
 * shape expresses two limits at once -- a burst ceiling and a sustained rate --
 * which a fixed window cannot:
 *
 * ```text
 * fixed window        11:59:59 ██████████ 200
 *                     12:00:00 ██████████ 200   ⇒ 400 in one second, "within
 *                                                  the limit" as configured
 *
 * token bucket        burst ≤ capacity, then strictly ≤ rate, always
 * ```
 *
 * ## Why there is no timer
 *
 * The naive implementation adds tokens on an interval, which means a timer per
 * bucket and a bucket per tenant. Instead store `(tokens, lastRefillMs)` and
 * compute the refill on read: a bucket that nobody touches for an hour costs
 * nothing and is correct the moment it is read again.
 *
 * ## Why this is here and not in the API
 *
 * The live limiter runs this same arithmetic inside a Redis Lua script, because
 * read-modify-write from the application is a lost-update race. Lua is not
 * unit-testable in isolation and is unpleasant to reason about, so the maths
 * lives here, pure and covered, and the script is a transliteration of it. The
 * two must stay in step -- `apps/api/src/lib/rate-limiter.ts` says so at the
 * script, and the integration suite checks the script against these numbers.
 */

export interface TokenBucketPolicy {
  /** Sustained rate: tokens added per minute. Must be greater than zero. */
  perMinute: number;
  /** Capacity: the largest burst permitted from a full bucket. */
  burst: number;
}

export interface TokenBucketState {
  /** Fractional on purpose -- rounding here would leak or destroy budget. */
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketDecision {
  allowed: boolean;
  /** What to persist. */
  state: TokenBucketState;
  /** Whole tokens left; what `X-RateLimit-Remaining` reports. */
  remaining: number;
  /** Time until the next token exists. Zero when the request was allowed. */
  retryAfterMs: number;
  /** Time until the bucket is full again; what `X-RateLimit-Reset` reports. */
  resetMs: number;
}

/** Tokens per millisecond. The unit the refill is actually done in. */
export function refillRatePerMs(policy: TokenBucketPolicy): number {
  return policy.perMinute / 60_000;
}

export function fullBucket(
  policy: TokenBucketPolicy,
  nowMs: number
): TokenBucketState {
  // A previously unseen caller starts full rather than empty. Starting empty
  // would make the first request of every new API key a 429.
  return { tokens: policy.burst, lastRefillMs: nowMs };
}

/**
 * Advances a bucket to `nowMs` without spending anything.
 *
 * Elapsed time is clamped at zero. Two API instances reading a clock that
 * disagrees by a second would otherwise let the one that is behind *subtract*
 * tokens, and a limiter that can move backwards is worse than none.
 */
export function refill(
  state: TokenBucketState,
  policy: TokenBucketPolicy,
  nowMs: number
): TokenBucketState {
  const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
  const tokens = Math.min(
    policy.burst,
    state.tokens + elapsedMs * refillRatePerMs(policy)
  );
  return { tokens, lastRefillMs: nowMs };
}

/**
 * Refills, then spends `cost` if it is there.
 *
 * The decision carries the numbers the response headers need, because deriving
 * them separately from the returned state is how `Retry-After` ends up
 * disagreeing with `X-RateLimit-Reset`.
 */
export function consume(
  state: TokenBucketState,
  policy: TokenBucketPolicy,
  nowMs: number,
  cost = 1
): TokenBucketDecision {
  const rate = refillRatePerMs(policy);
  const filled = refill(state, policy, nowMs);

  const allowed = filled.tokens >= cost;
  const tokens = allowed ? filled.tokens - cost : filled.tokens;

  return {
    allowed,
    state: { tokens, lastRefillMs: filled.lastRefillMs },
    // Floor, never round: reporting 1 token remaining when 0.4 is left invites
    // a request that is certain to be rejected.
    remaining: Math.floor(tokens),
    retryAfterMs: allowed ? 0 : Math.ceil((cost - tokens) / rate),
    resetMs: Math.ceil((policy.burst - tokens) / rate),
  };
}
