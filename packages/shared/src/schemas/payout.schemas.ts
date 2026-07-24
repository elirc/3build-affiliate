import { z } from 'zod';

export const requestPayoutSchema = z.object({
  method: z.enum(['stripe_connect', 'paypal', 'manual']).default('stripe_connect'),
});

export const reviewPayoutSchema = z.object({
  action: z.enum(['approve', 'reject', 'retry']),
  reason: z.string().max(500).optional(),
});

export type RequestPayoutInput = z.infer<typeof requestPayoutSchema>;
export type ReviewPayoutInput = z.infer<typeof reviewPayoutSchema>;
