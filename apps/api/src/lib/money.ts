import type { Prisma } from '@prisma/client';

/**
 * Formatting money for the wire.
 *
 * Postgres stores these as `Decimal(n, 2)`, and Prisma hands back a Decimal
 * object. That object's `toJSON` produces the shortest representation, so
 * `120.00` serialises as `"120"` while a total we computed and formatted
 * ourselves serialises as `"120.00"`. Two spellings of the same amount, from
 * the same API, depending on which endpoint you asked.
 *
 * A client then has to guess whether to parse or to display, and someone
 * eventually renders "$120" next to "$120.00" on the same screen.
 *
 * Everything crossing the boundary goes through here: always a string, always
 * two decimal places, never a float.
 */
export type MoneyLike = Prisma.Decimal | number | string | null | undefined;

export function money(value: MoneyLike): string {
  if (value === null || value === undefined) return '0.00';
  // Decimal, string and number all render correctly via Number here because
  // the values are bounded by Decimal(12,2) -- well inside the range where a
  // double is exact for two decimal places.
  return Number(value).toFixed(2);
}
