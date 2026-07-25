import type { PayoutStatus } from '@affiliate/shared';

/**
 * The payout state machine.
 *
 *   PENDING ──► PROCESSING ──► PAID
 *      │             │
 *      └─────────────┴──► FAILED
 *      │
 *      └──► CANCELLED
 *
 * PAID and CANCELLED are terminal. FAILED is not: a transfer that bounced
 * because of a bad bank detail should be retryable once the detail is fixed,
 * without the affiliate having to request the whole payout again.
 *
 * Uppercase here matches the Prisma enum. The wire format uses lowercase, and
 * the two are converted at the boundary rather than in the middle.
 */
export const PAYOUT_TRANSITIONS: Record<PayoutStatusUpper, PayoutStatusUpper[]> = {
  PENDING: ['PROCESSING', 'FAILED', 'CANCELLED'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: ['PROCESSING'],
  CANCELLED: [],
};

export type PayoutStatusUpper = Uppercase<PayoutStatus>;

export function canTransitionPayout(
  from: PayoutStatusUpper,
  to: PayoutStatusUpper
): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function allowedPayoutTransitions(
  from: PayoutStatusUpper
): PayoutStatusUpper[] {
  return PAYOUT_TRANSITIONS[from];
}

/**
 * Whether the commissions attached to a payout in this state are still
 * committed to it.
 *
 * When a payout fails or is cancelled the money was never sent, so the
 * commissions must go back to APPROVED and become available for a later
 * payout. Leaving them attached to a dead payout is how an affiliate's balance
 * silently disappears.
 */
export function releasesCommissions(to: PayoutStatusUpper): boolean {
  return to === 'FAILED' || to === 'CANCELLED';
}

/** Whether reaching this state means the money actually left. */
export function settlesCommissions(to: PayoutStatusUpper): boolean {
  return to === 'PAID';
}
