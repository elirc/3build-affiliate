import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

/** A worker that records how many of it were running at the same time. */
function trackingWorker(delayMs = 1) {
  const state = { inFlight: 0, peak: 0 };
  const worker = async (n: number) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight -= 1;
    return n * 2;
  };
  return { state, worker };
}

describe('mapWithConcurrency', () => {
  it('never exceeds the limit', () => {
    const { state, worker } = trackingWorker();
    const items = Array.from({ length: 50 }, (_, i) => i);

    return mapWithConcurrency(items, 10, worker).then(() => {
      expect(state.peak).toBeLessThanOrEqual(10);
    });
  });

  it('returns results in input order, not completion order', async () => {
    // Callers pair results back up by index. If the fastest item's result
    // landed first, every pairing after a slow one would be wrong.
    const results = await mapWithConcurrency([30, 20, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });

    expect(results).toEqual([30, 20, 10]);
  });

  it('actually runs in parallel up to the limit', async () => {
    const { state, worker } = trackingWorker(5);
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 10, worker);
    expect(state.peak).toBeGreaterThan(1);
  });

  it('handles an empty list without hanging', async () => {
    expect(await mapWithConcurrency([], 10, async () => 1)).toEqual([]);
  });
});
