import { describe, expect, it } from 'vitest';
import {
  consume,
  fullBucket,
  refill,
  refillRatePerMs,
  type TokenBucketDecision,
  type TokenBucketPolicy,
  type TokenBucketState,
} from './token-bucket';

/** The postback tier: 100/min sustained, 200 in one burst. */
const POLICY: TokenBucketPolicy = { perMinute: 100, burst: 200 };

const T0 = 1_700_000_000_000;

/** Spends `n` tokens back to back at the same instant. */
function spend(
  n: number,
  policy: TokenBucketPolicy = POLICY,
  start: TokenBucketState = fullBucket(policy, T0),
  nowMs = T0
) {
  let state = start;
  let allowedCount = 0;
  // Definite assignment rather than a throwaway first call: every caller here
  // spends at least once.
  let last!: TokenBucketDecision;

  for (let i = 0; i < n; i++) {
    last = consume(state, policy, nowMs);
    state = last.state;
    if (last.allowed) allowedCount += 1;
  }

  return { state, allowedCount, last };
}

describe('token bucket refill', () => {
  it('starts full so a new caller is not rejected on its first request', () => {
    const state = fullBucket(POLICY, T0);
    expect(state.tokens).toBe(200);
    expect(consume(state, POLICY, T0).allowed).toBe(true);
  });

  it('empties after exactly `burst` requests and rejects the next one', () => {
    const { state, allowedCount, last } = spend(200);

    expect(allowedCount).toBe(200);
    expect(state.tokens).toBe(0);
    expect(last.remaining).toBe(0);

    const overflow = consume(state, POLICY, T0);
    expect(overflow.allowed).toBe(false);
    expect(overflow.remaining).toBe(0);
  });

  it('adds exactly `perMinute / 60` tokens after one idle second', () => {
    const { state } = spend(200);
    // 100/min is 1.666… tokens per second, so one second buys one whole
    // request and change -- the assertion that catches a rate expressed in the
    // wrong unit, which is the classic way to be 60x wrong.
    const after = refill(state, POLICY, T0 + 1_000);

    expect(after.tokens).toBeCloseTo(100 / 60, 10);
    expect(consume(after, POLICY, T0 + 1_000).allowed).toBe(true);
  });

  it('never exceeds capacity however long it idles', () => {
    const { state } = spend(200);
    // A week. Without the clamp this bucket would hold ~1,008,000 tokens and
    // the next burst would be unbounded -- the failure mode is invisible until
    // an integration that has been quiet all weekend wakes up.
    const after = refill(state, POLICY, T0 + 7 * 24 * 60 * 60 * 1000);

    expect(after.tokens).toBe(200);
  });

  it('does not go backwards when a clock reads earlier than the last write', () => {
    // Two instances, one a second behind the other. Elapsed time is clamped,
    // so the laggard spends but cannot un-refill.
    const state: TokenBucketState = { tokens: 10, lastRefillMs: T0 };
    const after = refill(state, POLICY, T0 - 1_000);

    expect(after.tokens).toBe(10);
  });

  it('bounds the sustained rate no matter how the requests are spaced', () => {
    // Drain the burst, then take one token every second for five minutes.
    // Five minutes at 100/min is 500 tokens and the loop only asks for 300, so
    // every one is within the sustained rate and none is rejected.
    let state = spend(200).state;
    let allowed = 0;
    for (let second = 1; second <= 300; second++) {
      const decision = consume(state, POLICY, T0 + second * 1_000);
      state = decision.state;
      if (decision.allowed) allowed += 1;
    }

    expect(allowed).toBe(300);
  });
});

describe('token bucket headers', () => {
  it('reports a retry-after that is actually long enough', () => {
    const { state } = spend(200);
    const rejected = consume(state, POLICY, T0);

    expect(rejected.allowed).toBe(false);
    // 1.667 tokens/second ⇒ 600ms for one token. Telling the client to come
    // back any sooner guarantees a second 429.
    expect(rejected.retryAfterMs).toBe(600);
    expect(consume(state, POLICY, T0 + rejected.retryAfterMs).allowed).toBe(true);
    expect(consume(state, POLICY, T0 + rejected.retryAfterMs - 1).allowed).toBe(false);
  });

  it('reports a reset that is the time to a full bucket, not to one token', () => {
    const { state } = spend(200);
    const decision = consume(state, POLICY, T0);

    expect(decision.resetMs).toBe(Math.ceil(200 / refillRatePerMs(POLICY)));
    expect(refill(state, POLICY, T0 + decision.resetMs).tokens).toBe(200);
  });

  it('counts remaining down by one per allowed request', () => {
    let state = fullBucket(POLICY, T0);
    for (let i = 1; i <= 5; i++) {
      const decision = consume(state, POLICY, T0);
      state = decision.state;
      expect(decision.remaining).toBe(200 - i);
    }
  });

  it('floors a fractional balance rather than rounding it up', () => {
    // 0.5 tokens is not a request anybody can make. Rounding would advertise
    // one and then reject it.
    const decision = consume({ tokens: 1.5, lastRefillMs: T0 }, POLICY, T0);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(0);
  });
});

describe('token bucket tiers', () => {
  it('keeps each tier independent of the others', () => {
    const auth: TokenBucketPolicy = { perMinute: 10, burst: 15 };
    const authed: TokenBucketPolicy = { perMinute: 300, burst: 500 };

    expect(spend(15, auth).allowedCount).toBe(15);
    expect(consume(spend(15, auth).state, auth, T0).allowed).toBe(false);
    expect(spend(500, authed).allowedCount).toBe(500);
  });

  it('lets a burst through and then throttles to the sustained rate', () => {
    const auth: TokenBucketPolicy = { perMinute: 10, burst: 15 };

    // 30 login attempts as fast as a script can send them.
    const burst = spend(30, auth);
    expect(burst.allowedCount).toBe(15);

    // A minute later the attacker gets 10 more, not another 15. A fixed window
    // would have handed back the full 15 at the boundary.
    const later = spend(30, auth, burst.state, T0 + 60_000);
    expect(later.allowedCount).toBe(10);
  });
});
