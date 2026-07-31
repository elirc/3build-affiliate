import { describe, expect, it } from 'vitest';
import { bisectCommit } from './bisect';

/**
 * A commit that fails whenever the batch contains any poisoned item, which is
 * how a transaction behaves: one bad row rolls back the whole thing.
 */
function commitFailingOn(poison: number[]) {
  const committed: number[] = [];
  const commit = async (batch: number[]) => {
    if (batch.some((n) => poison.includes(n))) {
      throw new Error(`poison in batch of ${batch.length}`);
    }
    committed.push(...batch);
  };
  return { commit, committed };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('bisectCommit', () => {
  it('costs exactly one attempt when nothing fails', async () => {
    // The 99.9% case. Retry machinery that slows down the happy path is a bad
    // trade, so this is asserted rather than assumed.
    const { commit, committed } = commitFailingOn([]);
    const result = await bisectCommit(range(100), commit);

    expect(result.attempts).toBe(1);
    expect(result.succeeded).toHaveLength(100);
    expect(result.failed).toHaveLength(0);
    expect(committed).toHaveLength(100);
  });

  it('isolates one poison item and commits the other 99', async () => {
    const { commit, committed } = commitFailingOn([57]);
    const result = await bisectCommit(range(100), commit);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.item).toBe(57);
    expect(result.succeeded).toHaveLength(99);
    expect(committed).toHaveLength(99);
    expect(committed).not.toContain(57);
  });

  it('is logarithmic, not linear', async () => {
    // The whole justification for bisecting instead of writing one row at a
    // time. 100 items, one bad: about 2*log2(100) attempts, nowhere near 100.
    const { commit } = commitFailingOn([57]);
    const result = await bisectCommit(range(100), commit);

    expect(result.attempts).toBeLessThan(20);
  });

  it('finds several poison items', async () => {
    const { commit, committed } = commitFailingOn([3, 40, 41, 99]);
    const result = await bisectCommit(range(100), commit);

    expect(result.failed.map((f) => f.item).sort((a, b) => a - b)).toEqual([3, 40, 41, 99]);
    expect(result.succeeded).toHaveLength(96);
    expect(committed).toHaveLength(96);
  });

  it('terminates when every item is poison', async () => {
    // The case that recurses hardest. Without the batch-of-one base case this
    // would split forever.
    const { commit } = commitFailingOn(range(8));
    const result = await bisectCommit(range(8), commit);

    expect(result.failed).toHaveLength(8);
    expect(result.succeeded).toHaveLength(0);
  });

  it('handles a single failing item without recursing', async () => {
    const { commit } = commitFailingOn([0]);
    const result = await bisectCommit([0], commit);

    expect(result.attempts).toBe(1);
    expect(result.failed).toHaveLength(1);
  });

  it('does nothing with an empty batch', async () => {
    let called = 0;
    const result = await bisectCommit([], async () => {
      called += 1;
    });

    expect(called).toBe(0);
    expect(result.attempts).toBe(0);
  });

  it('keeps the error that each poison item produced', async () => {
    // The DLQ entry needs a reason, or an operator sees a parked message with
    // no way to tell why it will not go through.
    const result = await bisectCommit([1, 2], async (batch) => {
      if (batch.includes(2)) throw new Error('FK violation on trackingLinkId');
    });

    expect(result.failed).toHaveLength(1);
    expect((result.failed[0]!.error as Error).message).toContain('FK violation');
  });
});
