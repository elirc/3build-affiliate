import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  CsvStreamParser,
  csvHeader,
  missingColumns,
  selectColumns,
  type CsvRecord,
} from './csv-parse';

/** Feeds a whole document through in one chunk. */
function parseAll(text: string): CsvRecord[] {
  const parser = new CsvStreamParser();
  const records = parser.push(text);
  const last = parser.end();
  if (last) records.push(last);
  return records;
}

/**
 * Feeds a document one character at a time.
 *
 * The chunk boundary is where hand-written parsers break -- a `""` escape or a
 * `\r\n` split across two reads -- and a 64KB read on a 200MB file lands in an
 * arbitrary place 3,000 times. Parsing the same input both ways and asserting
 * they agree is the cheapest way to keep that honest.
 */
function parseByCharacter(text: string): CsvRecord[] {
  const parser = new CsvStreamParser();
  const records: CsvRecord[] = [];
  for (const ch of text) records.push(...parser.push(ch));
  const last = parser.end();
  if (last) records.push(last);
  return records;
}

describe('CsvStreamParser', () => {
  it('parses a plain file and numbers the lines from one', () => {
    const records = parseAll('a,b\n1,2\n3,4\n');

    expect(records).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['1', '2'] },
      { line: 3, values: ['3', '4'] },
    ]);
  });

  it('emits the last record when the file does not end with a newline', () => {
    expect(parseAll('a,b\n1,2')).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['1', '2'] },
    ]);
  });

  it('handles CRLF without leaving a carriage return in the value', () => {
    expect(parseAll('a,b\r\n1,2\r\n')).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['1', '2'] },
    ]);
  });

  it('keeps commas and newlines inside a quoted field', () => {
    const records = parseAll('a,b\n"x,y","line1\nline2"\n9,9\n');

    expect(records[1]).toEqual({ line: 2, values: ['x,y', 'line1\nline2'] });
    // The record after a two-line value starts on line 4, not line 3. This is
    // the whole reason line numbers are tracked separately from record counts.
    expect(records[2]).toEqual({ line: 4, values: ['9', '9'] });
  });

  it('unescapes a doubled quote', () => {
    expect(parseAll('a\n"say ""hi"""\n')).toEqual([
      { line: 1, values: ['a'] },
      { line: 2, values: ['say "hi"'] },
    ]);
  });

  it('skips blank lines rather than reporting them as empty rows', () => {
    // A trailing newline is universal, and a file with a blank line in the
    // middle is common. Neither is a row the brand needs to fix.
    expect(parseAll('a\n\n1\n\n')).toEqual([
      { line: 1, values: ['a'] },
      { line: 3, values: ['1'] },
    ]);
  });

  it('keeps an empty quoted field, which is not a blank line', () => {
    expect(parseAll('a,b\n"",2\n')).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['', '2'] },
    ]);
  });

  it('strips a byte-order mark from the first header', () => {
    // Excel writes one. Left in place it becomes part of the first column
    // name, and every file exported from Excel looks like it is missing a
    // required column.
    const [header] = parseAll('﻿externalOrderId,b\n1,2\n');
    expect(header!.values[0]).toBe('externalOrderId');
  });

  it('gives the same answer whatever the chunk boundaries are', () => {
    const doc = '﻿a,b,c\n1,"x,y",""\n"multi\nline","say ""hi""",3\r\n\nlast,,z';

    expect(parseByCharacter(doc)).toEqual(parseAll(doc));
  });

  it('refuses a file that ends inside an open quote', () => {
    // Not a bad row: everything after the stray quote has been swallowed into
    // one field, so the parse of the rest of the file is meaningless.
    expect(() => parseAll('a,b\n"never closed,2\n')).toThrow(CsvParseError);
  });

  it('holds only the record it is midway through', () => {
    // The memory claim, asserted structurally rather than with a stopwatch:
    // 10,000 rows pushed one chunk at a time are handed back and dropped, so
    // nothing accumulates inside the parser.
    const parser = new CsvStreamParser();
    let seen = 0;
    for (let i = 0; i < 10_000; i++) {
      seen += parser.push(`row${i},value${i}\n`).length;
    }

    expect(seen).toBe(10_000);
    expect(parser.end()).toBeNull();
  });
});

describe('csvHeader', () => {
  it('matches column names ignoring case and surrounding space', () => {
    const header = csvHeader([' ExternalOrderId ', 'CONVERSIONVALUE']);

    expect(missingColumns(header, ['externalOrderId', 'conversionValue'])).toEqual([]);
  });

  it('names every missing column, not just the first', () => {
    const header = csvHeader(['externalOrderId']);

    expect(missingColumns(header, ['externalOrderId', 'conversionValue', 'occurredAt'])).toEqual(
      ['conversionValue', 'occurredAt']
    );
  });

  it('keeps the first of two identically named columns', () => {
    const header = csvHeader(['a', 'a']);
    expect(header.index.get('a')).toBe(0);
  });
});

describe('selectColumns', () => {
  const header = csvHeader(['externalOrderId', 'conversionValue', 'note']);

  it('keys values by their canonical name and trims them', () => {
    const record = { line: 2, values: ['ord-1', ' 10.50 ', 'ignored'] };

    expect(selectColumns(header, record, ['externalOrderId', 'conversionValue'])).toEqual({
      externalOrderId: 'ord-1',
      conversionValue: '10.50',
    });
  });

  it('omits a column the file does not have', () => {
    const record = { line: 2, values: ['ord-1', '10.50', 'x'] };

    expect(selectColumns(header, record, ['externalOrderId', 'customerEmail'])).toEqual({
      externalOrderId: 'ord-1',
    });
  });

  it('rejects a row whose cell count does not match the header', () => {
    // An unquoted comma in a value shifts every column after it. The row is
    // not repairable, and importing it would write the wrong data silently.
    expect(selectColumns(header, { line: 2, values: ['ord-1', '10.50'] }, ['externalOrderId'])).toBeNull();
  });
});
