import { acceptsNewAffiliates } from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import { generateShortCode, MAX_TRACKING_LINKS_PER_AFFILIATE_PER_CAMPAIGN, type CachedTrackingLink, type CreateTrackingLinkInput } from '@affiliate/shared';
import { trackingLinkRepository } from '../repositories/tracking-link.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { relationshipService } from './relationship.service';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';

const CACHE_KEY = (code: string) => `link:${code}`;

/**
 * Kept in step with POSITIVE_TTL_SECONDS in the redirect service's resolver.
 *
 * This TTL is a backstop, not the correctness mechanism: writes invalidate
 * explicitly, and a cache miss now falls back to the database via the
 * internal lookup endpoint. Before that existed, this value was 3600 and a
 * link silently stopped working an hour after it was created.
 */
const CACHE_TTL_SECONDS = 86_400;

export function trackingService() {
  const links = trackingLinkRepository(prisma);
  const campaigns = campaignRepository(prisma);
  const relationships = relationshipService();

  async function cacheLink(code: string, payload: CachedTrackingLink) {
    await redis.set(CACHE_KEY(code), JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
  }

  /**
   * Drop a cached entry so the next click re-reads from the database.
   *
   * Used instead of rewriting the entry when the new value is not already in
   * hand. Deleting is safe because a miss is now recoverable; before the
   * resolver existed, deleting a key would have broken the link outright.
   */
  async function invalidateLink(code: string) {
    await redis.del(CACHE_KEY(code));
  }

  return {
    async create(affiliateId: string, input: CreateTrackingLinkInput) {
      const campaign = await campaigns.findById(input.campaignId);
      if (!campaign) throw Errors.notFound('Campaign');
      if (!acceptsNewAffiliates(campaign.status)) {
        // Naming the actual status matters: "not active" leaves an affiliate
        // guessing whether to wait (PAUSED) or give up (ENDED).
        throw Errors.badRequest(
          `This campaign is ${campaign.status.toLowerCase()} and is not accepting new links`
        );
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
      } else {
        // No campaign to build a full entry from. Drop the stale one rather
        // than leaving a cached `isActive: true` behind.
        await invalidateLink(link.shortCode);
      }
      return updated;
    },

    /**
     * Authoritative lookup for the redirect service's cache-miss path.
     *
     * Deliberately does not consult Redis: the caller has already missed, and
     * re-reading the cache here would just add a hop. The caller owns writing
     * the result back.
     */
    async resolveForRedirect(shortCode: string): Promise<CachedTrackingLink | null> {
      const link = await links.findByShortCodeForRedirect(shortCode);
      if (!link) return null;

      return {
        id: link.id,
        affiliateId: link.affiliateId,
        campaignId: link.campaignId,
        destinationUrl: link.destinationUrl,
        cookieLifetimeDays: link.campaign.cookieLifetimeDays,
        isActive: link.isActive,
        campaignStatus: link.campaign.status,
        campaignLandingPageUrl: link.campaign.landingPageUrl,
      };
    },
  };
}
