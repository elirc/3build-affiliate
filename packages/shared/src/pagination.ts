/**
 * Keyset ("seek") pagination.
 *
 * Offset pagination has two problems, and a junior engineer usually knows only
 * the second.
 *
 * **Correctness.** Conversions are ordered `occurredAt desc`. Between fetching
 * page 1 and page 2, three new conversions arrive. They land at the top and
 * shift everything down by three -- so rows 18, 19 and 20 from page 1 appear
 * *again* on page 2. Under deletion, rows are skipped entirely and never seen
 * at all. Any client that pages through everything and sums it gets a wrong
 * number, silently.
 *
 * **Cost.** `OFFSET 100000` makes Postgres produce and discard 100,000 rows.
 * The query gets linearly slower the deeper you page, so the slowest requests
 * are the ones a batch script runs most.
 *
 * Keyset pagination says "give me rows after *this specific row*" instead:
 *
 * ```sql
 * -- offset: plans a scan-and-discard, slower every page
 * SELECT * FROM "Conversion" ORDER BY "occurredAt" DESC OFFSET 100000 LIMIT 20;
 *
 * -- keyset: an index seek, same cost on page 1 and page 5000
 * SELECT * FROM "Conversion"
 * WHERE ("occurredAt", id) < ($1, $2)
 * ORDER BY "occurredAt" DESC, id DESC
 * LIMIT 20;
 * ```
 *
 * The hidden precondition is a **total order**. `occurredAt` is not unique, so
 * two conversions in the same millisecond can swap places between requests --
 * and a cursor pointing at one of them would be ambiguous. Adding `id` as a
 * tie-breaker makes the sort deterministic, which is what makes any of this
 * safe.
 */

export interface Cursor {
  /** The sort column's value for the last row of the previous page. */
  sortValue: string;
  /** That row's id, breaking ties so the ordering is total. */
  id: string;
}

export interface CursorPage<T> {
  data: T[];
  /**
   * `null` on the last page.
   *
   * Explicit rather than making clients compare `data.length` to the page
   * size -- that test is wrong whenever the final page happens to be exactly
   * full, and the bug only shows up on one dataset in `pageSize`.
   */
  nextCursor: string | null;
  hasMore: boolean;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Cursors are opaque on purpose.
 *
 * Not for secrecy -- base64 is not encryption and the contents are the client's
 * own data. It is so clients cannot *construct* them. The moment someone hand-
 * builds a cursor, the encoding is a public API and the sort key can never
 * change without breaking them.
 */
export function encodeCursor(sortValue: Date | string | number, id: string): string {
  const value = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue);
  return Buffer.from(JSON.stringify({ v: value, i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { v?: unknown }).v !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw new InvalidCursorError();
  }

  const { v, i } = parsed as { v: string; i: string };
  if (v.length === 0 || i.length === 0) throw new InvalidCursorError();

  return { sortValue: v, id: i };
}

/**
 * Turns `pageSize + 1` rows into a page.
 *
 * Fetching one extra row is how "is there more?" is answered without a second
 * `COUNT(*)` -- which on a large table costs more than the page itself.
 */
export function toCursorPage<T extends { id: string }>(
  rows: T[],
  pageSize: number,
  sortValueOf: (row: T) => Date | string | number
): CursorPage<T> {
  const hasMore = rows.length > pageSize;
  const data = hasMore ? rows.slice(0, pageSize) : rows;
  const last = data[data.length - 1];

  return {
    data,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(sortValueOf(last), last.id) : null,
  };
}
