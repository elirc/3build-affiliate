import crypto from 'node:crypto';

/**
 * A stable hash of a request body.
 *
 * Used to tell a genuine retry from a client reusing an idempotency key for
 * different content. That distinction only works if the hash depends on the
 * *meaning* of the body and not on its formatting, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` must produce the same value -- two JSON serialisers, or two
 * versions of the same client, will disagree about key order for identical
 * data, and treating that as a different request would reject legitimate
 * retries.
 *
 * Arrays are *not* sorted: `[1,2]` and `[2,1]` are genuinely different bodies.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalise(v)]));
  }

  return value;
}

export function fingerprint(body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalise(body ?? null)))
    .digest('hex');
}
