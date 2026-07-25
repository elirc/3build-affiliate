import { z } from 'zod';
import { MAX_COMMISSION_TIERS, MAX_FLAT_COMMISSION_USD } from '../constants/defaults';

export const commissionStructureSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('flat_per_sale'),
    flatAmount: z.number().positive().max(MAX_FLAT_COMMISSION_USD),
  }),
  z.object({
    type: z.literal('percentage'),
    percentage: z.number().positive().max(100),
    minCommission: z.number().min(0).optional(),
    maxCommission: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('tiered_percentage'),
    tiers: z
      .array(
        z.object({
          minSales: z.number().int().min(0),
          percentage: z.number().positive().max(100),
        })
      )
      .min(2)
      .max(MAX_COMMISSION_TIERS)
      .refine(
        (tiers) => {
          for (let i = 1; i < tiers.length; i++) {
            if (tiers[i]!.minSales <= tiers[i - 1]!.minSales) return false;
          }
          return true;
        },
        { message: 'Tiers must have ascending thresholds' }
      ),
  }),
  z.object({
    type: z.literal('recurring'),
    percentage: z.number().positive().max(100),
    recurringMonths: z.number().int().min(1).max(36),
  }),
]);

export const createCampaignSchema = z.object({
  name: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
  landingPageUrl: z.string().url(),
  allowedDomains: z.array(z.string().min(3)).min(1).max(50),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  commissionStructure: commissionStructureSchema,
  attributionModel: z.enum(['FIRST_CLICK', 'LAST_CLICK', 'LINEAR']).default('LAST_CLICK'),
  attributionWindowDays: z.number().int().min(1).max(90).default(30),
  cookieLifetimeDays: z.number().int().min(1).max(90).default(30),
  lockPeriodDays: z.number().int().min(0).max(90).default(30),
  isOpen: z.boolean().default(true),
});

/**
 * Field edits only. `status` is deliberately absent: state changes go through
 * POST /brand/campaigns/:id/transition, so there is exactly one code path
 * where the transition rules are enforced. A PATCH that could also change
 * status would be a second, unguarded door into the state machine.
 */
export const updateCampaignSchema = createCampaignSchema.partial().strict();

export const transitionCampaignSchema = z.object({
  to: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED']),
});

export const listCampaignsQuerySchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED']).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type TransitionCampaignInput = z.infer<typeof transitionCampaignSchema>;
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
