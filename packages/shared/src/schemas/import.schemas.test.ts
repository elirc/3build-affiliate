import { describe, expect, it } from 'vitest';
import {
  csvRowToImportInput,
  importRowSchema,
  normaliseCsvTimestamp,
  reportConversionSchema,
} from '../index';

/** The cells of one well-formed row, as the CSV reader hands them over. */
function row(overrides: Record<string, string> = {}) {
  return {
    externalOrderId: 'ord-1',
    trackingCode: 'abc123',
    conversionValue: '149.99',
    occurredAt: '2024-03-01T09:30:00Z',
    ...overrides,
  };
}

function parse(cells: Record<string, string>) {
  return importRowSchema.safeParse(csvRowToImportInput(cells));
}

describe('csvRowToImportInput', () => {
  it('turns cells into the shape the conversion schema expects', () => {
    const result = importRowSchema.parse(csvRowToImportInput(row()));

    expect(result).toMatchObject({
      externalOrderId: 'ord-1',
      trackingCode: 'abc123',
      conversionValue: 149.99,
      // Already valid ISO 8601, so it is passed through untouched.
      occurredAt: '2024-03-01T09:30:00Z',
      // Inherited from the postback schema rather than restated here.
      isFirstTimeCustomer: true,
    });
  });

  it('reads a money-formatted amount', () => {
    // What a spreadsheet writes when the column is formatted as currency.
    expect(parse(row({ conversionValue: '$1,249.50' })).success).toBe(true);
  });

  it('leaves an unparseable amount in place so the error names the column', () => {
    const result = parse(row({ conversionValue: 'twelve dollars' }));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['conversionValue']);
  });

  it('collects the sub-ID columns into one object', () => {
    const result = importRowSchema.parse(
      csvRowToImportInput(row({ subId1: 'newsletter', subId3: 'header' }))
    );

    expect(result.subIds).toEqual({ subId1: 'newsletter', subId3: 'header' });
  });

  it('omits sub-IDs entirely when every column is blank', () => {
    const result = importRowSchema.parse(csvRowToImportInput(row({ subId1: '', subId2: '  ' })));

    expect(result.subIds).toBeUndefined();
  });
});

describe('normaliseCsvTimestamp', () => {
  it('reads a bare date as midnight UTC', () => {
    expect(normaliseCsvTimestamp('2024-03-01')).toBe('2024-03-01T00:00:00.000Z');
  });

  it('reads a space-separated timestamp as UTC', () => {
    expect(normaliseCsvTimestamp('2024-03-01 09:30:00')).toBe('2024-03-01T09:30:00Z');
  });

  it('leaves a value that already carries an offset alone', () => {
    expect(normaliseCsvTimestamp('2024-03-01T09:30:00+02:00')).toBe(
      '2024-03-01T09:30:00+02:00'
    );
  });

  it('passes nonsense through so the schema rejects it', () => {
    expect(parse(row({ occurredAt: 'last tuesday' })).success).toBe(false);
  });
});

describe('importRowSchema', () => {
  it('requires a timestamp, unlike the postback schema', () => {
    // A live sale happened now. A migration of two years of history that
    // silently lands with today's date destroys what it was imported for.
    expect(reportConversionSchema.safeParse({
      externalOrderId: 'ord-1',
      conversionValue: 10,
    }).success).toBe(true);

    const { occurredAt: _dropped, ...withoutDate } = row();
    expect(parse(withoutDate).success).toBe(false);
  });

  it('requires a tracking code, because an imported row has no click to attribute to', () => {
    const { trackingCode: _dropped, ...withoutCode } = row();
    expect(parse(withoutCode).success).toBe(false);
  });

  it('rejects a non-positive amount, using the shared rule', () => {
    // Asserted here so that raising or relaxing the rule in one place cannot
    // leave the two entry points disagreeing.
    expect(parse(row({ conversionValue: '0' })).success).toBe(false);
    expect(parse(row({ conversionValue: '-5' })).success).toBe(false);
  });

  it('rejects an invalid customer email', () => {
    const result = parse(row({ customerEmail: 'not-an-email' }));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['customerEmail']);
  });
});
