import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How much of a request was spent waiting on Postgres.
 *
 * "The dashboard feels slow" is not a bug report anyone can act on, and the
 * two candidate answers -- one query that is slow, or forty that are not --
 * need completely different fixes. Recording both the total and the worst
 * single operation is what separates them without a profiler.
 */
export interface DbTiming {
  /**
   * Time inside Prisma, summed over every operation.
   *
   * This is database *work*, not time blocked: a handler that issues two
   * queries with `Promise.all` charges both, so the total can exceed the
   * request's wall clock. That is the number worth budgeting -- a shared
   * database cares how much work you caused, not how cleverly you overlapped
   * it.
   */
  totalMs: number;
  queries: number;
  slowest: { operation: string; ms: number } | null;
}

/**
 * The store is async-local rather than a field on the request because the
 * thing doing the measuring -- a Prisma middleware -- has no idea a request
 * exists. Threading a context object through every service and repository so
 * that logging could find it would be a large change to production code in
 * service of an observability feature, which is the wrong trade.
 */
const storage = new AsyncLocalStorage<DbTiming>();

export function newDbTiming(): DbTiming {
  return { totalMs: 0, queries: 0, slowest: null };
}

export function runWithDbTiming<T>(timing: DbTiming, fn: () => T): T {
  return storage.run(timing, fn);
}

/**
 * Adds one operation's elapsed time to whatever request is in scope.
 *
 * A no-op outside a request: workers, scripts and the test harness all use the
 * same Prisma client, and none of them has a budget to blow.
 */
export function recordDbTime(operation: string, ms: number): void {
  const timing = storage.getStore();
  if (!timing) return;

  timing.totalMs += ms;
  timing.queries += 1;
  if (!timing.slowest || ms > timing.slowest.ms) {
    timing.slowest = { operation, ms: Math.round(ms * 10) / 10 };
  }
}

/** Exposed for tests, which need to assert on timings without a live request. */
export function currentDbTiming(): DbTiming | undefined {
  return storage.getStore();
}
