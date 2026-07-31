import { describe, expect, it } from 'vitest';
import { redis } from '../src/config/redis';
import { INSTANCE_ID, readLeaseHolder, withLease } from '../src/lib/lease';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Leases for scheduled jobs.
 *
 * Against the old code every one of these is meaningless -- there was no lease
 * at all, and every instance ran every job on every tick. The tests that matter
 * most here are the two that are easy to skip: that a crashed holder's lease
 * expires, and that a stale release does not free somebody else's lease.
 */
describe('withLease', () => {
  it('runs the body for exactly one of many concurrent callers', async () => {
    let ran = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withLease('test-concurrent', 5_000, async () => {
          ran += 1;
          // Held long enough that the other nine are certain to overlap it.
          await sleep(100);
          return 'done';
        })
      )
    );

    expect(ran).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => !r.ran)).toHaveLength(9);
    expect(results.find((r) => r.ran)?.value).toBe('done');
  });

  it('releases when the body throws', async () => {
    await expect(
      withLease('test-throws', 5_000, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Released, not left held until the TTL -- otherwise one failing tick
    // stalls the job for the whole lease duration.
    expect(await readLeaseHolder('test-throws')).toBeNull();

    const after = await withLease('test-throws', 5_000, async () => 'ok');
    expect(after.ran).toBe(true);
  });

  it('lets the next caller in after a crashed holder stops renewing', async () => {
    // Simulates a process that acquired the lease and died: the key is set by
    // hand with a short TTL and nobody renews it.
    await redis.set('scheduler:lease:test-crash', 'dead-instance', 'PX', 300);

    const blocked = await withLease('test-crash', 5_000, async () => 'ran');
    expect(blocked.ran).toBe(false);

    await sleep(400);

    const recovered = await withLease('test-crash', 5_000, async () => 'ran');
    expect(recovered.ran).toBe(true);
  });

  it('does not release a lease it no longer holds', async () => {
    // The subtle one, and the reason release is a compare-and-delete rather
    // than a DEL.
    //
    // Instance A's lease expires mid-job. Instance B acquires. A then finishes
    // and releases. With DEL, A deletes B's lease -- so a third instance can
    // acquire while B is still working, and there is effectively no lock at
    // all. With compare-and-delete, A's release is a no-op.
    const name = 'test-stale-release';
    let bHolds = '';

    await withLease(name, 250, async () => {
      // Outlive our own TTL without renewing, by stopping renewal from
      // mattering: 250ms TTL renews at 1000ms (the floor), so this job of
      // 400ms loses the lease.
      await sleep(400);

      // Someone else takes it while we are still inside the body.
      await redis.set(`scheduler:lease:${name}`, 'instance-b', 'PX', 5_000);
      bHolds = 'instance-b';
    });

    // Our release ran on the way out of the block above. B must still hold it.
    expect(await readLeaseHolder(name)).toBe(bHolds);
  });

  it('signals the body when the lease is lost', async () => {
    let aborted = false;

    await withLease('test-abort', 250, async (signal) => {
      await sleep(400);
      // Renewal fires at the 1000ms floor, so force the loss directly: another
      // instance has taken the key, which is exactly what renewal detects.
      await redis.set('scheduler:lease:test-abort', 'someone-else', 'PX', 5_000);
      await sleep(1_200);
      aborted = signal.aborted;
    });

    // Losing a lease silently is worse than crashing: the job carries on
    // believing it is protected while another instance runs the same work.
    expect(aborted).toBe(true);

    await redis.del('scheduler:lease:test-abort');
  });

  it('keeps a job alive past its original TTL by renewing', async () => {
    // The TTL must be *shorter* than the job for this to test anything.
    //
    // Written first as a 3s lease around a 2.5s job, which passed without
    // renewal existing at all -- the lease simply had not expired yet. A test
    // that cannot fail is not a test.
    //
    // 1.5s lease, renewing at 1s, around a 2.5s job: without renewal the key
    // is gone at 1.5s and this reads null.
    const name = 'test-renew';

    const result = await withLease(name, 1_500, async () => {
      await sleep(2_500);
      return readLeaseHolder(name);
    });

    expect(result.ran).toBe(true);
    expect(result.value).toBe(INSTANCE_ID);
  });

  it('records who holds the lease', async () => {
    await withLease('test-holder', 5_000, async () => {
      expect(await readLeaseHolder('test-holder')).toBe(INSTANCE_ID);
    });
    expect(await readLeaseHolder('test-holder')).toBeNull();
  });
});
