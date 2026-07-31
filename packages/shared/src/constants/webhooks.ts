/**
 * The events a brand can subscribe an endpoint to.
 *
 * Dotted rather than underscored, and deliberately unlike `NOTIFICATION_TYPES`
 * even where they describe the same moment. A notification is internal copy we
 * can reword whenever we like; a webhook event type is part of a published
 * contract that someone else's code branches on, and renaming one breaks their
 * integration silently. Keeping the two vocabularies apart is what lets the
 * internal one stay editable.
 */
export const WEBHOOK_EVENT_TYPES = [
  'conversion.approved',
  'conversion.reversed',
  'payout.completed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Header names on an outbound delivery. */
export const WEBHOOK_HEADERS = {
  deliveryId: 'X-Delivery-Id',
  eventType: 'X-Event-Type',
  signature: 'X-Signature',
  timestamp: 'X-Timestamp',
} as const;
