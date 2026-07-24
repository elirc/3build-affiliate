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

export type ReportConversionInput = z.infer<typeof reportConversionSchema>;
export type ReviewConversionInput = z.infer<typeof reviewConversionSchema>;
