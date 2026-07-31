import { describe, expect, it } from 'vitest';
import {
  currentDbTiming,
  newDbTiming,
  recordDbTime,
  runWithDbTiming,
} from './db-timing';

describe('db timing', () => {
  it('sums the time of every operation in scope', () => {
    const timing = newDbTiming();
    runWithDbTiming(timing, () => {
      recordDbTime('ClickEvent.createMany', 12);
      recordDbTime('raw.queryRaw', 30);
    });

    expect(timing.totalMs).toBe(42);
    expect(timing.queries).toBe(2);
  });

  it('remembers which single operation was worst', () => {
    // The total says a request was slow; this says whether to go and look at
    // one query or at forty.
    const timing = newDbTiming();
    runWithDbTiming(timing, () => {
      recordDbTime('User.findUnique', 2);
      recordDbTime('raw.queryRaw', 180);
      recordDbTime('Campaign.findMany', 5);
    });

    expect(timing.slowest).toEqual({ operation: 'raw.queryRaw', ms: 180 });
  });

  it('does nothing at all outside a request', () => {
    // Workers, scripts and the seed all share this Prisma client and none of
    // them has a budget. Recording into a global would make one long worker
    // pass look like a slow request.
    expect(currentDbTiming()).toBeUndefined();
    expect(() => recordDbTime('ClickEvent.createMany', 5000)).not.toThrow();
  });

  it('keeps two concurrent requests apart', async () => {
    // The whole point of AsyncLocalStorage over a module-level counter: two
    // requests in flight must not be charged for each other's queries.
    const first = newDbTiming();
    const second = newDbTiming();

    await Promise.all([
      runWithDbTiming(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        recordDbTime('raw.queryRaw', 100);
      }),
      runWithDbTiming(second, async () => {
        recordDbTime('User.findUnique', 1);
      }),
    ]);

    expect(first.totalMs).toBe(100);
    expect(second.totalMs).toBe(1);
  });
});
