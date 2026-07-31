import { z } from 'zod';
import { reportConversionSchema } from './conversion.schemas';

/**
 * The CSV a brand uploads to migrate historical conversions.
 *
 * The row schema is `reportConversionSchema` with the differences a file
 * imposes, **not** a second copy of it. Two schemas for the same object drift:
 * someone raises the order-id length on the postback endpoint, the import
 * keeps truncating at the old bound, and the two entry points disagree about
 * what a valid conversion is. Every rule the two paths share is stated once,
 * in `conversion.schemas.ts`, and inherited here.
 *
 * Three things genuinely differ, and each is narrowed deliberately below.
 */

/**
 * Sub-ID columns. Five, because `MAX_SUB_ID_KEYS` is five -- a sixth would be
 * dropped on write, so accepting it in the file would be a lie.
 */
export const IMPORT_SUB_ID_COLUMNS = [
  'subId1',
  'subId2',
  'subId3',
  'subId4',
  'subId5',
] as const;

/**
 * Columns whose absence makes the *file* malformed rather than a row invalid.
 *
 * `trackingCode` is here and is not in the story's list, because a conversion
 * has to belong to an affiliate: `Conversion.trackingLinkId` and
 * `affiliateId` are NOT NULL. A live postback resolves them from the
 * attribution cookie's clicks; a historical row has no click events at all --
 * that is the premise of the whole feature -- so the file has to name the link
 * the sale came through. Making it required means a brand whose export lacks
 * it is told once, immediately, instead of receiving 100,000 identical row
 * errors.
 */
export const IMPORT_REQUIRED_COLUMNS = [
  'externalOrderId',
  'trackingCode',
  'conversionValue',
  'occurredAt',
] as const;

export const IMPORT_OPTIONAL_COLUMNS = [
  'customerEmail',
  ...IMPORT_SUB_ID_COLUMNS,
] as const;

export const IMPORT_COLUMNS = [
  ...IMPORT_REQUIRED_COLUMNS,
  ...IMPORT_OPTIONAL_COLUMNS,
] as const;

export const importRowSchema = reportConversionSchema
  .omit({
    // A cookie id is meaningless in an import: it is only useful for finding
    // click events inside the attribution window, and historical rows predate
    // any click we hold.
    attributionCookieId: true,
    // Not a column. A CSV cell cannot carry a JSON object, and the sub-IDs
    // arrive as five flat columns instead.
    metadata: true,
  })
  .extend({
    /** The short code from the tracking link the sale came through. */
    trackingCode: z.string().min(1).max(64),
    /**
     * Required, where the postback endpoint defaults it to "now".
     *
     * Defaulting is right for a live sale and wrong for a migration: a file of
     * two years of history that silently lands with today's date destroys the
     * very thing the brand is importing it for.
     */
    occurredAt: z.string().datetime(),
    subIds: z.record(z.string(), z.string()).optional(),
  });

export type ImportRowInput = z.infer<typeof importRowSchema>;

/**
 * ISO 8601 with an offset, which is what `z.string().datetime()` accepts.
 *
 * Real exports are not that tidy. `2024-03-01` and `2024-03-01 09:30:00` are
 * both extremely common, and rejecting every row of an otherwise good file
 * over a missing `T` helps nobody. Both are read as UTC -- stated here, in the
 * API docs, and nowhere else, because a silent timezone assumption is how an
 * import lands a day early for half a year of data.
 */
export function normaliseCsvTimestamp(raw: string): string {
  const value = raw.trim();
  if (value === '') return value;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;

  const withT = value.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(withT)) {
    return `${withT}Z`;
  }

  return value;
}

/**
 * Turns one row of cells into something `importRowSchema` can judge.
 *
 * Every CSV cell is a string, so the numbers and booleans the schema expects
 * have to be produced somewhere. Doing it here rather than by loosening the
 * schema keeps the postback endpoint strict: a JSON body sending
 * `"conversionValue": "12.00"` is still a client bug, and should still be
 * rejected as one.
 *
 * A value that will not convert is passed through untouched so the schema
 * reports it against the right column, rather than being dropped and reported
 * as missing.
 */
export function csvRowToImportInput(
  cells: Record<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  const orderId = cells.externalOrderId?.trim();
  if (orderId) input.externalOrderId = orderId;

  const code = cells.trackingCode?.trim();
  if (code) input.trackingCode = code;

  const rawValue = cells.conversionValue?.trim();
  if (rawValue) {
    // Thousands separators and a currency symbol are what a spreadsheet
    // produces when someone formats the column as money.
    const cleaned = rawValue.replace(/[$£€,\s]/g, '');
    const parsed = Number(cleaned);
    input.conversionValue = Number.isFinite(parsed) ? parsed : rawValue;
  }

  const occurredAt = cells.occurredAt?.trim();
  if (occurredAt) input.occurredAt = normaliseCsvTimestamp(occurredAt);

  const email = cells.customerEmail?.trim();
  if (email) input.customerEmail = email;

  const subIds: Record<string, string> = {};
  for (const column of IMPORT_SUB_ID_COLUMNS) {
    const value = cells[column]?.trim();
    if (value) subIds[column] = value;
  }
  if (Object.keys(subIds).length > 0) input.subIds = subIds;

  return input;
}

export const importJobStatuses = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
] as const;

export type ImportJobStatusValue = (typeof importJobStatuses)[number];
