/**
 * An incremental RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency, because the thing we
 * need from a CSV parser here is not "turn this string into rows" -- it is
 * **bounded memory** and **honest line numbers**, and most parsers give you at
 * most one of those:
 *
 * - Bounded memory means the parser must accept the file a chunk at a time and
 *   emit records as they complete, holding only the record it is midway
 *   through. `readFile` + `split('\n')` holds the file twice over, and dies on
 *   a 200MB upload in the worst way: the process runs out of memory and takes
 *   every in-flight request with it.
 * - Honest line numbers mean the number reported for a record is the line in
 *   the *file the user uploaded*. A quoted field may contain newlines, so the
 *   nth record and the nth line are not the same thing, and a report that
 *   confuses them sends a brand looking at the wrong row.
 *
 * Kept pure -- no streams, no fs -- so the awkward cases (a quote split across
 * two chunks, a newline inside a quoted field, a file that ends without one)
 * can be tested by calling `push` with the chunk boundaries in exactly the
 * places that break parsers.
 */

/** A parsed record and where it started in the source file. */
export interface CsvRecord {
  /** 1-based line number of the record's first character. */
  line: number;
  values: string[];
}

/** Raised for input no parser could resolve, which makes the file malformed. */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const QUOTE = '"';
const DELIMITER = ',';
const BOM = '﻿';

export class CsvStreamParser {
  /** Inside a quoted field: commas and newlines are data until it closes. */
  private inQuotes = false;
  /**
   * Saw a `"` while inside quotes and cannot yet tell what it meant.
   *
   * `""` is an escaped quote and `",` closes the field -- and the two
   * characters can land in different chunks, which is why this is state on the
   * parser rather than a lookahead.
   */
  private pendingQuote = false;
  private field = '';
  private fields: string[] = [];
  /** Whether the current record has consumed anything at all. */
  private started = false;
  private physicalLine = 1;
  private recordLine = 1;
  private atFileStart = true;

  /** Feeds a chunk in and returns every record it completed. */
  push(chunk: string): CsvRecord[] {
    let text = chunk;
    if (this.atFileStart) {
      // Excel writes a byte-order mark. Left in place it becomes part of the
      // first header name, so `externalOrderId` silently stops matching and
      // every file exported from Excel looks like it is missing a column.
      if (text.startsWith(BOM)) text = text.slice(1);
      this.atFileStart = false;
    }

    const records: CsvRecord[] = [];

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;

      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === QUOTE) {
          this.field += QUOTE;
          continue;
        }
        this.inQuotes = false;
        // Falls through: this character still has to be handled as ordinary
        // unquoted input.
      }

      if (this.inQuotes) {
        if (ch === QUOTE) {
          this.pendingQuote = true;
          continue;
        }
        if (ch === '\n') this.physicalLine += 1;
        this.field += ch;
        continue;
      }

      if (ch === QUOTE && this.field === '') {
        this.begin();
        this.inQuotes = true;
        continue;
      }

      if (ch === DELIMITER) {
        this.begin();
        this.fields.push(this.field);
        this.field = '';
        continue;
      }

      if (ch === '\n') {
        const record = this.finish();
        this.physicalLine += 1;
        if (record) records.push(record);
        continue;
      }

      // A bare CR is either half of a CRLF or a Mac Classic line ending; either
      // way it is not data once we are outside quotes.
      if (ch === '\r') continue;

      this.begin();
      this.field += ch;
    }

    return records;
  }

  /**
   * Ends the stream, returning a final record if the file did not end with a
   * newline -- which is most files.
   */
  end(): CsvRecord | null {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      throw new CsvParseError(
        `Unterminated quoted field starting on line ${this.recordLine}`
      );
    }
    return this.finish();
  }

  private begin() {
    if (this.started) return;
    this.started = true;
    this.recordLine = this.physicalLine;
  }

  private finish(): CsvRecord | null {
    // A blank line is not an empty record. Files routinely end with a newline,
    // and treating that as a row means every import reports one bogus failure.
    if (!this.started) {
      this.fields = [];
      this.field = '';
      return null;
    }

    this.fields.push(this.field);
    const record: CsvRecord = { line: this.recordLine, values: this.fields };
    this.fields = [];
    this.field = '';
    this.started = false;
    return record;
  }
}

export interface CsvHeader {
  /** How many cells a well-formed row in this file has. */
  width: number;
  /** Normalised column name to its position. */
  index: Map<string, number>;
}

/**
 * Reads the header row.
 *
 * Matching is case-insensitive and ignores surrounding space: `Order ID` and
 * `externalOrderId` are genuinely different columns, but `externalOrderId ` and
 * `ExternalOrderId` are not, and refusing a file over a trailing space in a
 * header is a bad way to meet a new customer.
 */
export function csvHeader(values: string[]): CsvHeader {
  const index = new Map<string, number>();
  values.forEach((raw, i) => {
    const key = raw.trim().toLowerCase();
    // First wins. A duplicated column is ambiguous, and the later one is more
    // likely to be the stray.
    if (key && !index.has(key)) index.set(key, i);
  });
  return { width: values.length, index };
}

/** The required columns that are absent, in the order they were asked for. */
export function missingColumns(
  header: CsvHeader,
  required: readonly string[]
): string[] {
  return required.filter((name) => !header.index.has(name.toLowerCase()));
}

/**
 * Pulls the columns we care about out of a record, keyed by their canonical
 * name so callers never deal in positions.
 *
 * Returns null when the record has a different number of cells than the header
 * -- usually an unquoted comma inside a value. Every column after it has
 * shifted, so the row cannot be salvaged, and guessing which one moved would
 * import silently wrong data.
 */
export function selectColumns(
  header: CsvHeader,
  record: CsvRecord,
  columns: readonly string[]
): Record<string, string> | null {
  if (record.values.length !== header.width) return null;

  const out: Record<string, string> = {};
  for (const name of columns) {
    const at = header.index.get(name.toLowerCase());
    if (at === undefined) continue;
    const value = record.values[at];
    if (value !== undefined) out[name] = value.trim();
  }
  return out;
}
