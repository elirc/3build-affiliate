import { describe, expect, it } from 'vitest';
import { csvDate, csvRow, escapeCsvValue, paginate, streamCsv } from './csv';

describe('escapeCsvValue', () => {
  it('leaves ordinary values alone', () => {
    expect(escapeCsvValue('Acme')).toBe('Acme');
    expect(escapeCsvValue(42)).toBe('42');
  });

  it('quotes and doubles embedded quotes', () => {
    // The case from the story. Get this wrong and every column after it in
    // the row shifts -- the file still opens, it is just wrong from here on.
    expect(escapeCsvValue('Bob\'s "Big", Sale')).toBe('"Bob\'s ""Big"", Sale"');
  });

  it('quotes values containing newlines', () => {
    expect(escapeCsvValue('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvValue('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('neutralises formulas', () => {
    // Excel, Sheets and LibreOffice all execute these. Every value in these
    // exports is user-supplied, so this is not hypothetical.
    expect(escapeCsvValue('=cmd|\'/c calc\'!A1')).toBe("'=cmd|'/c calc'!A1");
    expect(escapeCsvValue('+1234')).toBe("'+1234");
    expect(escapeCsvValue('-1+1')).toBe("'-1+1");
    expect(escapeCsvValue('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  });

  it('neutralises a formula that also needs quoting', () => {
    // Order matters: prefix first, then quote, or the apostrophe ends up
    // inside the quotes in the wrong place.
    expect(escapeCsvValue('=A1,B2')).toBe('"\'=A1,B2"');
  });

  it('renders null and undefined as empty', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('does not mangle a negative number that is really a number', () => {
    // A trade-off: -42.50 is prefixed too, because a cell cannot be both
    // safely inert and natively numeric. Money in these exports is a string
    // for reconciliation anyway.
    expect(escapeCsvValue('-42.50')).toBe("'-42.50");
  });
});

describe('csvRow', () => {
  it('joins with commas and ends CRLF', () => {
    // CRLF because RFC 4180 says so and because Excel on Windows is the
    // single most likely consumer.
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});

describe('csvDate', () => {
  it('always emits ISO-8601 UTC', () => {
    expect(csvDate(new Date('2026-03-04T05:06:07.000Z'))).toBe(
      '2026-03-04T05:06:07.000Z'
    );
  });

  it('renders a missing date as empty rather than "Invalid Date"', () => {
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });
});

describe('streamCsv', () => {
  it('emits a header then the rows', async () => {
    const columns = [
      { header: 'Name', value: (r: { name: string }) => r.name },
      { header: 'Value', value: (r: { value: number }) => r.value },
    ];

    async function* pages() {
      yield [{ name: 'a', value: 1 }];
      yield [{ name: 'b', value: 2 }];
    }

    const out: string[] = [];
    for await (const chunk of streamCsv(columns, pages())) out.push(chunk);

    expect(out.join('')).toBe('Name,Value\r\na,1\r\nb,2\r\n');
  });

  it('emits the header even with no rows', async () => {
    // An empty file with no header looks like a broken export. A header-only
    // file is unambiguous: the query ran and matched nothing.
    async function* pages(): AsyncGenerator<Array<{ name: string }>> {}
    const out: string[] = [];
    for await (const chunk of streamCsv(
      [{ header: 'Name', value: (r: { name: string }) => r.name }],
      pages()
    )) {
      out.push(chunk);
    }
    expect(out.join('')).toBe('Name\r\n');
  });

  it('yields per page, not per row', async () => {
    async function* pages() {
      yield [{ n: 1 }, { n: 2 }, { n: 3 }];
    }
    const chunks: string[] = [];
    for await (const c of streamCsv([{ header: 'N', value: (r: { n: number }) => r.n }], pages())) {
      chunks.push(c);
    }
    // Header plus one chunk for the page -- not one per row, which on a 50k
    // export would be 50,000 writes.
    expect(chunks).toHaveLength(2);
  });
});

describe('paginate', () => {
  it('stops on a short page', async () => {
    const calls: number[] = [];
    const gen = paginate(async (skip, take) => {
      calls.push(skip);
      return skip === 0 ? Array.from({ length: take }, (_, i) => i) : [1, 2];
    }, 3);

    const pages: number[][] = [];
    for await (const p of gen) pages.push(p);

    expect(pages).toEqual([[0, 1, 2], [1, 2]]);
    expect(calls).toEqual([0, 3]);
  });

  it('stops immediately on an empty first page', async () => {
    const gen = paginate(async () => [], 10);
    const pages = [];
    for await (const p of gen) pages.push(p);
    expect(pages).toEqual([]);
  });
});
