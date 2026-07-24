import { Errors } from '../lib/errors';
import { generateShortCode, MAX_TRACKING_LINKS_PER_AFFILIATE_PER_CAMPAIGN, type CachedTrackingLink, type CreateTrackingLinkInput } from '@affiliate/shared';
import { trackingLinkRepository } from '../repositories/tracking-link.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { relationshipService } from './relationship.service';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';

const CACHE_KEY = (code: string) => `link:${code}`;
const CACHE_TTL_SECONDS = 3600;

export function trackingService() {
  const links = trackingLinkRepository(prisma);
  const campaigns = campaignRepository(prisma);
  const relationships = relationshipService();

  async function cacheLink(code: string, payload: CachedTrackingLink) {
    await redis.set(CACHE_KEY(code), JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
  }

  return {
    async create(affiliateId: string, input: CreateTrackingLinkInput) {
      const campaign = await campaigns.findById(input.campaignId);
      if (!campaign) throw Errors.notFound('Campaign');
      if (campaign.status !== 'ACTIVE') {
        throw Errors.badRequest('Campaign is not active');
      }

      await relationships.assertApproved(campaign.brandId, affiliateId);

      const existingCount = await links.countForAffiliateOnCampaign(
        affiliateId,
        input.campaignId
      );
      if (existingCount >= MAX_TRACKING_LINKS_PER_AFFILIATE_PER_CAMPAIGN) {
        throw Errors.badRequest('Tracking link limit reached for this campaign');
      }

      const destUrl = new URL(input.destinationUrl);
      const allowed = campaign.allowedDomains.some(
        (d) => destUrl.hostname === d || destUrl.hostname.endsWith('.' + d)
      );
      if (!allowed) {
        throw Errors.badRequest('Destination domain not allowed for this campaign');
      }

      let shortCode = generateShortCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const collision = await links.findByShortCode(shortCode);
        if (!collision) break;
        shortCode = generateShortCode();
      }

      const link = await links.create({
        affiliateId,
        campaignId: input.campaignId,
        shortCode,
        destinationUrl: input.destinationUrl,
        customAlias: input.customAlias ?? null,
        isActive: true,
      });

      await cacheLink(shortCode, {
        id: link.id,
        affiliateId: link.affiliateId,
        campaignId: link.campaignId,
        destinationUrl: link.destinationUrl,
        cookieLifetimeDays: campaign.cookieLifetimeDays,
        isActive: true,
      });

      return link;
    },

    async listMine(affiliateId: string) {
      return links.listByAffiliate(affiliateId);
    },

    async toggleActive(affiliateId: string, linkId: string, isActive: boolean) {
      const link = await links.findById(linkId);
      if (!link) throw Errors.notFound('Tracking link');
      if (link.affiliateId !== affiliateId) throw Errors.forbidden();
      const updated = await links.setActive(linkId, isActive);
      const campaign = await campaigns.findById(link.campaignId);
      if (campaign) {
        await cacheLink(link.shortCode, {
          id: link.id,
          affiliateId: link.affiliateId,
          campaignId: link.campaignId,
          destinationUrl: link.destinationUrl,
          cookieLifetimeDays: campaign.cookieLifetimeDays,
          isActive,
        });
      }
      return updated;
    },
  };
}
