import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_MAX_ATTEMPTS,
  backoffCeilingMs,
  nextDelayMs,
  seedFrom,
} from './backoff';

/** The mean delay for an attempt across a large sample of seeds. */
function meanDelay(attempt: number, samples = 2000): number {
  let total = 0;
  for (let seed = 0; seed < samples; seed++) {
    total += nextDelayMs(attempt, seed);
  }
  return total / samples;
}

describe('backoffCeilingMs', () => {
  it('doubles from one second to thirty-two', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffCeilingMs(a))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
  });

  it('stops growing past the last attempt', () => {
    // Nothing should ever ask for attempt 7, but an off-by-one in a caller
    // must not turn into a delay measured in days.
    expect(backoffCeilingMs(WEBHOOK_MAX_ATTEMPTS + 10)).toBe(
      backoffCeilingMs(WEBHOOK_MAX_ATTEMPTS)
    );
  });
});

describe('nextDelayMs', () => {
  it('never exceeds the ceiling for its attempt', () => {
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const ceiling = backoffCeilingMs(attempt);
      for (let seed = 0; seed < 500; seed++) {
        expect(nextDelayMs(attempt, seed)).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('never returns zero', () => {
    // A zero delay retries inside the same tick, which gives the far end no
    // time at all to have recovered.
    for (let seed = 0; seed < 1000; seed++) {
      expect(nextDelayMs(1, seed)).toBeGreaterThan(0);
    }
  });

  it('grows monotonically in expectation', () => {
    // Individual draws are not ordered -- that is the whole point of jitter --
    // so the property that holds is about the mean.
    const means = [1, 2, 3, 4, 5, 6].map((a) => meanDelay(a));
    for (let i = 1; i < means.length; i++) {
      expect(means[i]!).toBeGreaterThan(means[i - 1]!);
    }
  });

  it('averages about half the ceiling, which is what full jitter buys', () => {
    // If this drifts towards the ceiling the distribution is no longer
    // uniform, and the herd is only partly dispersed.
    const mean = meanDelay(6);
    const ceiling = backoffCeilingMs(6);
    expect(mean).toBeGreaterThan(ceiling * 0.4);
    expect(mean).toBeLessThan(ceiling * 0.6);
  });

  it('gives two seeds different delays', () => {
    // The reason the module exists: a thousand deliveries failing at the same
    // instant must not retry at the same instant.
    const delays = new Set(
      Array.from({ length: 200 }, (_, seed) => nextDelayMs(4, seed))
    );
    expect(delays.size).toBeGreaterThan(150);
  });

  it('is deterministic for a given seed', () => {
    expect(nextDelayMs(3, 12345)).toBe(nextDelayMs(3, 12345));
  });
});

describe('seedFrom', () => {
  it('separates two deliveries', () => {
    expect(seedFrom('delivery-a', 1)).not.toBe(seedFrom('delivery-b', 1));
  });

  it('separates one delivery’s successive attempts', () => {
    // Seeding on the id alone would make a delivery that drew a low value
    // once draw a low value every time.
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((a) => seedFrom('delivery-a', a)));
    expect(seeds.size).toBe(6);
  });
});
