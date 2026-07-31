/**
 * Isolating a poison message in a batch.
 *
 * A batch write fails for two very different reasons, and only one of them can
 * be predicted:
 *
 * - Things knowable *without* the database -- a missing field, a bad type, an
 *   out-of-range number. Validate per message before the transaction; that is
 *   cheap and needs no retries.
 * - Things knowable only *from* the database -- a foreign key that does not
 *   resolve, a unique violation, a constraint. You cannot predict these, so
 *   when a batch fails you have to find out which message caused it.
 *
 * The obvious answer to the second is to give up on batching and write one row
 * at a time. That costs `n` transactions on every batch to protect against a
 * failure that happens on almost none of them.
 *
 * Bisection costs `O(log n)` transactions *only when a batch actually fails*,
 * and nothing at all otherwise:
 *
 * ```text
 * [100] ✗
 *   ├── [50] ✓ committed
 *   └── [50] ✗
 *         ├── [25] ✓ committed
 *         └── [25] ✗ … ⇒ 1 poison message isolated, 99 written
 * ```
 *
 * Kept pure and free of Redis and Prisma so the recursion can be tested
 * against a synthetic "fails if it contains X" predicate, which is far easier
 * to reason about than a database that fails for real.
 */

export interface BisectResult<T> {
  /** Items that were successfully committed, in no particular order. */
  succeeded: T[];
  /** Items isolated as individually failing, with the error each produced. */
  failed: { item: T; error: unknown }[];
  /** How many times `commit` was called. Asserted in tests as the cost. */
  attempts: number;
}

/**
 * Commits `items`, splitting on failure until each failure is a single item.
 *
 * `commit` must be all-or-nothing for the slice it is given -- a transaction.
 * If it partially applies its slice, retrying halves of that slice will
 * duplicate whatever already landed.
 */
export async function bisectCommit<T>(
  items: T[],
  commit: (batch: T[]) => Promise<void>
): Promise<BisectResult<T>> {
  const result: BisectResult<T> = { succeeded: [], failed: [], attempts: 0 };
  if (items.length === 0) return result;

  async function attempt(batch: T[]): Promise<void> {
    result.attempts += 1;
    try {
      await commit(batch);
      result.succeeded.push(...batch);
      return;
    } catch (error) {
      // A batch of one that fails *is* the poison message. This is also the
      // recursion's base case -- without it, a single failing item would split
      // into itself forever.
      if (batch.length === 1) {
        result.failed.push({ item: batch[0]!, error });
        return;
      }

      const mid = Math.floor(batch.length / 2);
      // Sequential, not Promise.all: the halves write to the same tables, and
      // running them concurrently would reintroduce the interleaving that
      // batching exists to avoid.
      await attempt(batch.slice(0, mid));
      await attempt(batch.slice(mid));
    }
  }

  await attempt(items);
  return result;
}
