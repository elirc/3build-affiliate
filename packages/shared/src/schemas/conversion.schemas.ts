import { z } from 'zod';

export const reportConversionSchema = z.object({
  externalOrderId: z.string().min(1).max(200),
  conversionValue: z.number().positive(),
  attributionCookieId: z.string().min(1).max(200).optional(),
  customerEmail: z.string().email().optional(),
  isFirstTimeCustomer: z.boolean().default(true),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const reviewConversionSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
});

export const reverseConversionSchema = z.object({
  /**
   * Always required. A reversal takes money back from someone who has already
   * been told they earned it, so the reason appears in their earnings view --
   * a silent deduction destroys trust faster than the deduction itself.
   */
  reason: z.string().min(1).max(500),
  /**
   * Omit for a full refund. A partial amount reduces the commission in
   * proportion and leaves the conversion in place.
   */
  refundAmount: z.number().positive().optional(),
});

export const recurringBillingSchema = z.object({
  /**
   * The id of the *original* order, so a brand does not have to store one of
   * our identifiers to report a renewal.
   */
  externalReference: z.string().min(1).max(200),
  amount: z.number().positive(),
  occurredAt: z.string().datetime().optional(),
});

export type RecurringBillingInput = z.infer<typeof recurringBillingSchema>;
export type ReportConversionInput = z.infer<typeof reportConversionSchema>;
export type ReviewConversionInput = z.infer<typeof reviewConversionSchema>;
export type ReverseConversionInput = z.infer<typeof reverseConversionSchema>;
