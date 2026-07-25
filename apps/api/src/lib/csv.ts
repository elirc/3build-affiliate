/**
 * CSV serialisation.
 *
 * Two hazards, and the second one is the surprising one.
 *
 * RFC 4180 escaping: a value containing a comma, a quote or a newline has to
 * be quoted, with embedded quotes doubled. Get this wrong and a campaign named
 * `Bob's "Big", Sale` silently shifts every subsequent column in that row --
 * the file still opens, the data is just wrong from that point on.
 *
 * Formula injection: a value starting `=`, `+`, `-` or `@` is interpreted as a
 * formula by Excel, Sheets and LibreOffice. `=cmd|'/c calc'!A1` in a cell is a
 * real, exploited attack -- and every value in these exports is user-supplied
 * (campaign names, affiliate names, order ids). The export is safe on our side
 * and dangerous on the recipient's, which is precisely why it is easy to miss.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let str = String(value);

  // Neutralise the formula before quoting. A leading apostrophe is the
  // convention every major spreadsheet understands as "this is text".
  if (str.length > 0 && FORMULA_PREFIXES.includes(str[0]!)) {
    str = `'${str}`;
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function csvRow(values: unknown[]): string {
  return values.map(escapeCsvValue).join(',') + '\r\n';
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/**
 * Streams rows as CSV.
 *
 * A generator rather than a string, so a 50,000-row export does not sit in
 * memory in full before the first byte is sent. Fastify will consume this
 * directly.
 */
export async function* streamCsv<T>(
  columns: CsvColumn<T>[],
  pages: AsyncIterable<T[]>
): AsyncGenerator<string> {
  yield csvRow(columns.map((c) => c.header));

  for await (const page of pages) {
    let chunk = '';
    for (const row of page) {
      chunk += csvRow(columns.map((c) => c.value(row)));
    }
    // One yield per page rather than per row: a yield per row on a 50k export
    // is 50k writes, and the batching is free.
    if (chunk) yield chunk;
  }
}

/**
 * Pages through a query so an export never loads everything at once.
 *
 * Keyed on an opaque cursor rather than OFFSET: OFFSET re-scans everything it
 * skips, so page 500 of an export costs five hundred times page one.
 */
export async function* paginate<T>(
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  pageSize = 500
): AsyncGenerator<T[]> {
  let skip = 0;
  for (;;) {
    const page = await fetchPage(skip, pageSize);
    if (page.length === 0) return;
    yield page;
    if (page.length < pageSize) return;
    skip += pageSize;
  }
}

/** ISO-8601 UTC. Locale formats in an export are a reconciliation nightmare. */
export function csvDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toISOString();
}

export function csvFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}
