import { acceptsNewAffiliates } from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import { brandAffiliateRepository } from '../repositories/brand-affiliate.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { prisma } from '../config/prisma';
import type { ApplyToCampaignInput } from '@affiliate/shared';

/**
 * BrandAffiliate is keyed by (brandId, affiliateId), not by campaign. An
 * affiliate "applies to a brand" — once approved, they can create links on
 * any of that brand's open campaigns. We accept a campaignId as the entry
 * point so the public/program page can drive the application UX.
 */
export function relationshipService() {
  const repo = brandAffiliateRepository(prisma);
  const campaigns = campaignRepository(prisma);

  return {
    async apply(affiliateId: string, input: ApplyToCampaignInput) {
      const campaign = await campaigns.findById(input.campaignId);
      if (!campaign) throw Errors.notFound('Campaign');
      if (!acceptsNewAffiliates(campaign.status)) {
        throw Errors.badRequest(
          `This campaign is ${campaign.status.toLowerCase()} and is not accepting applications`
        );
      }

      const existing = await repo.findByPair(campaign.brandId, affiliateId);
      if (existing) {
        if (existing.status === 'APPROVED') return existing;
        if (existing.status === 'PENDING') return existing;
        throw Errors.conflict(
          existing.status === 'REJECTED'
            ? 'Your previous application was rejected'
            : 'Relationship is deactivated'
        );
      }

      if (campaign.isOpen) {
        const rel = await repo.apply(campaign.brandId, affiliateId, input.message);
        // Open programs auto-approve
        return repo.setStatus(rel.id, 'APPROVED');
      }
      return repo.apply(campaign.brandId, affiliateId, input.message);
    },

    listForBrand(brandId: string, status?: string) {
      return repo.listForBrand(brandId, status);
    },

    listForAffiliate(affiliateId: string) {
      return repo.listForAffiliate(affiliateId);
    },

    async review(
      brandId: string,
      relationshipId: string,
      action: 'approve' | 'reject' | 'deactivate'
    ) {
      const rel = await repo.findById(relationshipId);
      if (!rel) throw Errors.notFound('Relationship');
      if (rel.brandId !== brandId) throw Errors.forbidden();
      const next =
        action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'DEACTIVATED';
      return repo.setStatus(relationshipId, next);
    },

    async assertApproved(brandId: string, affiliateId: string) {
      const rel = await repo.findByPair(brandId, affiliateId);
      if (!rel || rel.status !== 'APPROVED') {
        throw Errors.forbidden('You are not approved to promote this brand');
      }
      return rel;
    },
  };
}
