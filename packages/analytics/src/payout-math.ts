/**
 * Payout arithmetic.
 *
 * Extracted from the service so the rounding can be tested without a
 * database. Money maths is exactly the sort of thing that looks obviously
 * correct and is not: the original
 *
 *     Math.round(gross * PLATFORM_FEE_PERCENT) / 100
 *
 * happens to be right, but only because the two operations compose --
 * multiplying by the percent and dividing by 100 -- and it reads like a bug.
 */

export interface PayoutBreakdown {
  /** Total commission being paid, before the platform's cut. */
  gross: string;
  /** The platform's cut. */
  fee: string;
  /** What actually reaches the affiliate. */
  net: string;
}

/**
 * Splits a gross amount into fee and net, both rounded to cents.
 *
 * The fee is rounded and the net is computed as `gross - fee` rather than
 * being rounded independently. Rounding both separately can produce a fee and
 * a net that do not add back up to the gross, which is a penny the books
 * cannot explain.
 */
export function calculatePayoutBreakdown(
  grossAmount: number,
  feePercent: number
): PayoutBreakdown {
  const gross = round2(grossAmount);
  const fee = round2((gross * feePercent) / 100);
  const net = round2(gross - fee);

  return { gross: gross.toFixed(2), fee: fee.toFixed(2), net: net.toFixed(2) };
}

/**
 * Rounds to cents, compensating for binary floating point.
 *
 * `Math.round(x * 100) / 100` alone gets 1.005 wrong, because 1.005 is
 * actually 1.00499999999999989 as a double and rounds down. Nudging through
 * the decimal string representation first avoids the class of "we are one
 * penny out and nobody can reproduce it" bugs.
 */
function round2(value: number): number {
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}
