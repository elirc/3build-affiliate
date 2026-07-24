import { z } from 'zod';

export const createTrackingLinkSchema = z.object({
  campaignId: z.string().min(1),
  destinationUrl: z.string().url(),
  customAlias: z.string().min(1).max(60).optional(),
});

export const applyToCampaignSchema = z.object({
  campaignId: z.string().min(1),
  message: z.string().max(1000).optional(),
});

export type CreateTrackingLinkInput = z.infer<typeof createTrackingLinkSchema>;
export type ApplyToCampaignInput = z.infer<typeof applyToCampaignSchema>;
