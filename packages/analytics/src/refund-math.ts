/**
 * Refund arithmetic.
 *
 * A partial refund reduces the commission in proportion to the value that was
 * given back. The alternative -- recomputing the commission from scratch
 * against the reduced order value -- looks equivalent and is not, because
 * tiered and bounded structures are not linear. Recomputing a 20% commission
 * with a $15 minimum on a half-refunded $40 order would pay the affiliate the
 * same $15 as before the refund.
 *
 * Proportional reduction keeps the original deal intact: the affiliate keeps
 * exactly the share of their commission that matches the share of the order
 * the customer kept.
 */

export interface RefundOutcome {
  /** Order value remaining after the refund. */
  remainingValue: string;
  /** Commission the affiliate keeps. */
  remainingCommission: string;
  /** Commission being taken back. */
  clawbackAmount: string;
  /** True when nothing of the order remains. */
  isFullRefund: boolean;
}

export function calculateRefund(
  originalValue: number,
  originalCommission: number,
  refundAmount: number
): RefundOutcome {
  if (refundAmount <= 0) {
    throw new Error('Refund amount must be positive');
  }
  if (refundAmount > originalValue) {
    throw new Error('Refund amount cannot exceed the original order value');
  }

  const remainingValue = round2(originalValue - refundAmount);

  // Guard against a zero-value order rather than producing NaN. An order worth
  // nothing cannot have earned a proportional commission anyway.
  const keptShare = originalValue === 0 ? 0 : remainingValue / originalValue;

  const remainingCommission = round2(originalCommission * keptShare);
  // Derived by subtraction so the two always add back to the original. Rounding
  // both independently can leave a penny nobody can account for.
  const clawbackAmount = round2(originalCommission - remainingCommission);

  return {
    remainingValue: remainingValue.toFixed(2),
    remainingCommission: remainingCommission.toFixed(2),
    clawbackAmount: clawbackAmount.toFixed(2),
    isFullRefund: remainingValue === 0,
  };
}

function round2(value: number): number {
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}
