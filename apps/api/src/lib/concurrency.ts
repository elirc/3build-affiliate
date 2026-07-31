/**
 * Runs `worker` over `items`, never more than `limit` at once.
 *
 * `Promise.all` over a claimed batch is the obvious thing and the wrong one for
 * outbound requests: fifty deliveries become fifty simultaneous sockets, each
 * able to hold for the full request timeout, and the pipeline's load on the
 * outside world is set by whatever happened to be pending rather than by
 * anything we chose. A bound makes the cost of a bad tick predictable.
 *
 * Results come back in the order the items were given, not the order they
 * finished, so a caller can pair them up by index.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  // One runner per slot, each pulling the next index off a shared cursor.
  // Chunking into fixed groups instead would idle the whole group waiting for
  // its slowest member, which for a batch containing one hanging endpoint is
  // most of the timeout.
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
