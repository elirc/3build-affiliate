/**
 * The events a user can be told about.
 *
 * Kept in shared so the API, the worker and the UI cannot disagree about what
 * a type is called -- a typo'd type string would otherwise mean a preference
 * that silently never matches anything.
 */
export const NOTIFICATION_TYPES = [
  'application_approved',
  'application_rejected',
  'conversion_approved',
  'conversion_rejected',
  'commission_unlocked',
  'payout_paid',
  'payout_failed',
  'commission_clawed_back',
  'fraud_blocked',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Types a user cannot switch off.
 *
 * These are financial facts, not marketing. Someone whose commission was
 * clawed back or whose payout failed has to be told, whatever their
 * preferences say -- letting them opt out of that would mean money changing
 * hands silently, which is how a platform loses trust for good.
 */
export const MANDATORY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'payout_paid',
  'payout_failed',
  'commission_clawed_back',
];

export function isMandatoryNotification(type: string): boolean {
  return (MANDATORY_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/** Human-readable copy, so the worker and the bell agree on wording. */
export const NOTIFICATION_COPY: Record<NotificationType, string> = {
  application_approved: 'Your application was approved',
  application_rejected: 'Your application was not accepted',
  conversion_approved: 'A sale was approved',
  conversion_rejected: 'A sale was rejected',
  commission_unlocked: 'A commission is now available for payout',
  payout_paid: 'Your payout has been sent',
  payout_failed: 'Your payout failed',
  commission_clawed_back: 'A commission was reversed',
  fraud_blocked: 'A conversion was blocked by fraud review',
};
