import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '../constants/webhooks';

/**
 * `https` only, and not merely by convention.
 *
 * A delivery carries an HMAC over the body, which proves who sent it but hides
 * nothing: over plain http the conversion values, order ids and hashed
 * customer identifiers in the payload are readable by anyone on the path. A
 * brand who wants that has to say so somewhere other than here.
 */
export const createWebhookEndpointSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith('https://'), {
      message: 'Webhook urls must use https',
    }),
  /**
   * Explicit rather than "everything by default". An endpoint written for one
   * event type receives a payload it has never seen the moment we ship a new
   * one, and the failure lands on the brand.
   */
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const listDeliveriesQuerySchema = z.object({
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
