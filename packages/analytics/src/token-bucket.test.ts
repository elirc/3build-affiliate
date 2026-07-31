import { describe, expect, it } from 'vitest';
import {
  bucketSpec,
  consume,
  fullBucket,
  refill,
  type TokenBucketSpec,
  type TokenBucketState,
} from './token-bucket';

const T0 = 1_700_000_000_000;

/** 60 a minute bursting to 100: one token a second, a hundred in hand. */
const spec: TokenBucketSpec = bucketSpec(60, 100);

/** Spends `n` tokens at a single instant, returning the bucket afterwards. */
function drain(state: TokenBucketState, n: number, nowMs: number): TokenBucketState {
  let current = state;
  for (let i = 0; i < n; i += 1) {
    current = consume(current, spec, nowMs).state;
  }
  return current;
}

describe('bucketSpec', () => {
  it('separates the burst ceiling from the sustained rate', () => {
    expect(bucketSpec(300, 500)).toEqual({ capacity: 500, refillPerSecond: 5 });
  });
});

describe('refill', () => {
  it('adds exactly the rate after one second', () => {
    // The load-bearing arithmetic. If this drifts, every limit in the system
    // is quietly a different number than the one written in the config.
    const empty: TokenBucketState = { tokens: 0, lastRefillMs: T0 };
    expect(refill(empty, spec, T0 + 1_000).tokens).toBe(1);
    expect(refill(empty, spec, T0 + 10_000).tokens).toBe(10);
  });

  it('never exceeds capacity however long it idles', () => {
    // The reason the bucket is clamped: a client that goes quiet for a week
    // must not come back holding a week of tokens and replay them in a second,
    // which is precisely the burst the limiter exists to prevent.
    const empty: TokenBucketState = { tokens: 0, lastRefillMs: T0 };
    const week = 7 * 24 * 60 * 60 * 1000;

    expect(refill(empty, spec, T0 + week).tokens).toBe(spec.capacity);
    expect(refill(empty, spec, T0 + week * 52).tokens).toBe(spec.capacity);
  });

  it('stands still when the clock goes backwards', () => {
    // An NTP correction, or two instances that disagree. Trusting a negative
    // elapsed time would *remove* tokens from a client that did nothing wrong,
    // and rewinding lastRefillMs would hand out the same second twice.
    const state: TokenBucketState = { tokens: 40, lastRefillMs: T0 };
    expect(refill(state, spec, T0 - 5_000)).toEqual(state);
  });

  it('is unchanged at the same instant', () => {
    const state: TokenBucketState = { tokens: 40, lastRefillMs: T0 };
    expect(refill(state, spec, T0)).toEqual(state);
  });
});

describe('consume', () => {
  it('empties the bucket after exactly capacity requests', () => {
    const state = drain(fullBucket(spec, T0), spec.capacity, T0);
    expect(state.tokens).toBe(0);

    const next = consume(state, spec, T0);
    expect(next.allowed).toBe(false);
    expect(next.remaining).toBe(0);
  });

  it('allows the last token and rejects the one after it', () => {
    // Off-by-one at the boundary is the failure that ships: a limit of 100
    // that actually allows 99 or 101 passes any test that only checks "gets
    // rejected eventually".
    const state = drain(fullBucket(spec, T0), spec.capacity - 1, T0);

    const last = consume(state, spec, T0);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);

    expect(consume(last.state, spec, T0).allowed).toBe(false);
  });

  it('lets exactly the refill rate through after one second of throttling', () => {
    const emptied = drain(fullBucket(spec, T0), spec.capacity, T0);
    const oneSecondLater = T0 + 1_000;

    // One token a second, so one gets through and the next does not.
    const first = consume(emptied, spec, oneSecondLater);
    expect(first.allowed).toBe(true);
    expect(consume(first.state, spec, oneSecondLater).allowed).toBe(false);
  });

  it('reports a retryAfter that is actually long enough', () => {
    // The contract behind the Retry-After header: waiting exactly that long
    // must succeed. If it is short by a millisecond the client retries, is
    // rejected again, and we have taught it that the header is a lie.
    const emptied = drain(fullBucket(spec, T0), spec.capacity, T0);
    const rejected = consume(emptied, spec, T0);

    expect(rejected.retryAfterMs).toBe(1_000);
    expect(consume(rejected.state, spec, T0 + rejected.retryAfterMs).allowed).toBe(true);
  });

  it('reports a reset that reaches capacity and not before', () => {
    const emptied = drain(fullBucket(spec, T0), spec.capacity, T0);
    const { resetMs } = consume(emptied, spec, T0);

    // 100 tokens at one a second.
    expect(resetMs).toBe(100_000);
    expect(refill(emptied, spec, T0 + resetMs).tokens).toBe(spec.capacity);
    expect(refill(emptied, spec, T0 + resetMs - 1).tokens).toBeLessThan(spec.capacity);
  });

  it('reports zero reset for a bucket that is already full', () => {
    const full = fullBucket(spec, T0);
    // One token spent, one second to earn it back.
    expect(consume(full, spec, T0).resetMs).toBe(1_000);
    expect(consume(full, spec, T0).allowed).toBe(true);
  });

  it('never reports more remaining than a client can spend', () => {
    // `remaining` is floored, so 0.9 tokens reads as 0. Rounding it up would
    // promise a request that the very next call rejects.
    const partial: TokenBucketState = { tokens: 0.9, lastRefillMs: T0 };
    const decision = consume(partial, spec, T0);

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('refuses a cost larger than the tokens in hand without spending them', () => {
    const state: TokenBucketState = { tokens: 3, lastRefillMs: T0 };
    const decision = consume(state, spec, T0, 5);

    expect(decision.allowed).toBe(false);
    // A rejected request must not partially drain the bucket, or a client
    // asking for too much repeatedly would starve one asking for a little.
    expect(decision.state.tokens).toBe(3);
    expect(decision.retryAfterMs).toBe(2_000);
  });

  it('reports whole periods for a rate that is not a whole number per second', () => {
    // 10 a minute is one every six seconds, and `1 / (10 / 60) * 1000` is
    // 6000.000000000000333 in floating point. A naive ceil makes that 6001ms,
    // which surfaces as `Retry-After: 7` on a limit whose period is 6 -- a
    // limiter that quietly disagrees with its own configuration. This is the
    // brute-force tier's exact arithmetic.
    const auth = bucketSpec(10, 15);
    const emptied = (() => {
      let state = fullBucket(auth, T0);
      for (let i = 0; i < 15; i += 1) state = consume(state, auth, T0).state;
      return state;
    })();

    const rejected = consume(emptied, auth, T0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(6_000);
    expect(rejected.resetMs).toBe(90_000);
  });

  it('spends a burst faster than it refills but bounds the sustained rate', () => {
    // The behaviour the whole design is for: 500 at once is fine, and the
    // 501st in the same instant is not, but a minute later 300 more are.
    const authenticated = bucketSpec(300, 500);
    let state = fullBucket(authenticated, T0);

    for (let i = 0; i < 500; i += 1) {
      const decision = consume(state, authenticated, T0);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    expect(consume(state, authenticated, T0).allowed).toBe(false);

    expect(refill(state, authenticated, T0 + 60_000).tokens).toBe(300);
  });
});
