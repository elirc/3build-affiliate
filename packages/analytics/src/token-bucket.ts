/**
 * The refill arithmetic behind rate limiting.
 *
 * A bucket of capacity `C` refills at `R` tokens per second. A request takes
 * one token; no token means reject. That single idea gives you two numbers
 * that a fixed window cannot express at the same time: the largest burst you
 * tolerate (`C`) and the sustained rate you allow (`R`).
 *
 * A fixed window of 200/minute permits 400 requests in one second across the
 * boundary -- 200 at 11:59:59 and 200 at 12:00:00 -- while rejecting a
 * perfectly ordinary client that sends 201 evenly spaced over the minute. The
 * bucket does the opposite, which is what you wanted in the first place.
 *
 * ```text
 *  tokens
 *    C ─┬───────╮                    ╭────────  refills at R/s
 *       │       ╰──╮              ╭──╯
 *       │          ╰──╮        ╭──╯
 *    0 ─┴─────────────╰────────╯──────────────  burst drains, then throttled
 * ```
 *
 * There is no timer anywhere. Store `(tokens, lastRefillMs)` and compute the
 * refill lazily whenever the bucket is next touched -- an idle bucket costs
 * nothing and a busy one is exact.
 *
 * Kept pure and free of Redis so the boundaries -- an empty bucket, a bucket
 * that has idled for a week, a clock that goes backwards -- are testable
 * without a server. The Lua in `apps/api/src/lib/rate-limiter.ts` implements
 * exactly this, atomically; these tests are what pin the maths down.
 */

export interface TokenBucketSpec {
  /** Largest burst allowed, and the ceiling the bucket refills to. */
  capacity: number;
  /** Sustained rate. Tokens added per second once the burst is spent. */
  refillPerSecond: number;
}

export interface TokenBucketState {
  tokens: number;
  /** When `tokens` was last recomputed, as epoch milliseconds. */
  lastRefillMs: number;
}

export interface TokenBucketDecision {
  allowed: boolean;
  /** The bucket after the decision. Persist this. */
  state: TokenBucketState;
  /** Whole tokens a client may still spend right now. */
  remaining: number;
  /** Milliseconds until one token exists. Zero when the request was allowed. */
  retryAfterMs: number;
  /** Milliseconds until the bucket is back at capacity. */
  resetMs: number;
}

/**
 * `Math.ceil` for a duration that is mathematically whole.
 *
 * Ten tokens a minute is one every six seconds, but `1 / (10 / 60) * 1000`
 * is 6000.000000000000333 in binary floating point, and a plain `ceil` turns
 * that into 6001ms -- which becomes a `Retry-After` of 7 seconds for a limit
 * whose period is 6. The epsilon is a millionth of a millisecond: far below
 * anything a rate limit cares about, and far above the width of the error.
 */
function ceilMs(ms: number): number {
  return Math.ceil(ms - 1e-9);
}

/**
 * Turns the units limits are written in -- "300 a minute, bursting to 500" --
 * into the units the bucket works in.
 *
 * Burst and rate are separate on purpose. Setting `burst` equal to `perMinute`
 * gives you back a smooth version of a fixed window; setting it higher buys
 * headroom for a client that batches without raising what it can sustain.
 */
export function bucketSpec(perMinute: number, burst: number): TokenBucketSpec {
  return { capacity: burst, refillPerSecond: perMinute / 60 };
}

/** A full bucket. New clients start with their whole burst available. */
export function fullBucket(spec: TokenBucketSpec, nowMs: number): TokenBucketState {
  return { tokens: spec.capacity, lastRefillMs: nowMs };
}

/**
 * Advances a bucket to `nowMs` without spending anything.
 *
 * Clamped at `capacity`, which is the whole reason an idle bucket cannot
 * accumulate a month of tokens and let one client replay them in a second.
 */
export function refill(
  state: TokenBucketState,
  spec: TokenBucketSpec,
  nowMs: number
): TokenBucketState {
  // A clock that goes backwards -- an NTP correction, two servers disagreeing
  // -- must not subtract tokens or rewind `lastRefillMs`. Standing still is
  // the only safe response to a time we cannot trust.
  if (nowMs <= state.lastRefillMs) return state;

  const elapsedMs = nowMs - state.lastRefillMs;
  const tokens = Math.min(
    spec.capacity,
    state.tokens + (elapsedMs * spec.refillPerSecond) / 1000
  );
  return { tokens, lastRefillMs: nowMs };
}

/**
 * Refills, then spends `cost` if it is there.
 *
 * `retryAfterMs` is the part clients actually need. Rejecting without saying
 * when to come back leaves a client with nothing to do but retry immediately,
 * so a limiter without it converts a burst into a permanent hammering.
 */
export function consume(
  state: TokenBucketState,
  spec: TokenBucketSpec,
  nowMs: number,
  cost = 1
): TokenBucketDecision {
  const refilled = refill(state, spec, nowMs);
  const allowed = refilled.tokens >= cost;
  const after: TokenBucketState = allowed
    ? { ...refilled, tokens: refilled.tokens - cost }
    : refilled;
  const msFor = (tokens: number) => (tokens / spec.refillPerSecond) * 1000;

  return {
    allowed,
    state: after,
    // Floored: reporting 0.9 tokens as 1 promises a request that would be
    // rejected.
    remaining: Math.floor(after.tokens),
    retryAfterMs: allowed ? 0 : ceilMs(msFor(cost - after.tokens)),
    resetMs: ceilMs(msFor(spec.capacity - after.tokens)),
  };
}
