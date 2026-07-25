import { acceptsNewAffiliates } from '@affiliate/analytics';
import { Prisma } from '@prisma/client';
import { Errors } from '../lib/errors';
import { brandAffiliateRepository } from '../repositories/brand-affiliate.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { prisma } from '../config/prisma';
import { enqueueNotification } from './notification.service';
import type { ApplyToCampaignInput, CommissionStructure } from '@affiliate/shared';

/**
 * Widens a validated commission structure to Prisma's JSON input type.
 *
 * `CommissionStructure` is a union of interfaces, and TypeScript will not
 * accept an interface where an index signature is required -- an interface can
 * always be extended with non-JSON members, so it is not *provably* JSON, even
 * though ours is. A type alias would satisfy it; changing the public shape of
 * CommissionStructure to work around a storage detail is the wrong trade.
 *
 * Safe because the value has already been through commissionStructureSchema.
 */
function toJsonInput(structure: CommissionStructure): Prisma.InputJsonObject {
  return structure as unknown as Prisma.InputJsonObject;
}

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

      return prisma.$transaction(async (tx) => {
        const updated = await tx.brandAffiliate.update({
          where: { id: relationshipId },
          data: {
            status: next,
            ...(next === 'APPROVED' ? { approvedAt: new Date() } : {}),
            ...(next === 'REJECTED' ? { rejectedAt: new Date() } : {}),
            ...(next === 'DEACTIVATED' ? { deactivatedAt: new Date() } : {}),
          },
        });

        if (action === 'approve' || action === 'reject') {
          await enqueueNotification(tx, {
            userId: rel.affiliateId,
            type: action === 'approve' ? 'application_approved' : 'application_rejected',
            payload: { brandId, relationshipId },
          });
        }

        return updated;
      });
    },

    /**
     * Sets or clears a per-affiliate commission override.
     *
     * Applies to every campaign this brand runs, because BrandAffiliate is
     * brand-scoped rather than campaign-scoped. That is surfaced in the UI
     * copy so a brand is not surprised to find a rate they negotiated for one
     * programme applying to another.
     *
     * Only affects conversions recorded after the change. Existing
     * commissions are never recalculated -- an affiliate who was paid 20% on a
     * sale last month was paid correctly at the time.
     */
    async setCustomCommission(
      brandId: string,
      relationshipId: string,
      structure: CommissionStructure | null,
      actorId: string
    ) {
      const rel = await repo.findById(relationshipId);
      if (!rel) throw Errors.notFound('Relationship');
      if (rel.brandId !== brandId) throw Errors.forbidden();
      if (rel.status !== 'APPROVED') {
        throw Errors.badRequest(
          'Custom rates can only be set for an approved affiliate'
        );
      }

      return prisma.$transaction(async (tx) => {
        const updated = await tx.brandAffiliate.update({
          where: { id: relationshipId },
          data: {
            // Prisma.DbNull writes a real SQL NULL. Passing `null` to a
            // nullable Json column stores the *JSON value* null instead, which
            // is a different thing: it is present, and `customCommission !=
            // null` would be false while the column is not actually empty.
            customCommission:
              structure === null ? Prisma.DbNull : toJsonInput(structure),
          },
        });

        // Written in the same transaction as the change, so a crash cannot
        // leave a new rate with no record of who set it.
        await tx.commissionOverrideEvent.create({
          data: {
            brandAffiliateId: relationshipId,
            actorId,
            previousValue:
              (rel.customCommission as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
            newValue: structure === null ? Prisma.DbNull : toJsonInput(structure),
          },
        });

        return updated;
      });
    },

    async overrideHistory(brandId: string, relationshipId: string) {
      const rel = await repo.findById(relationshipId);
      if (!rel) throw Errors.notFound('Relationship');
      if (rel.brandId !== brandId) throw Errors.forbidden();
      return prisma.commissionOverrideEvent.findMany({
        where: { brandAffiliateId: relationshipId },
        orderBy: { createdAt: 'desc' },
      });
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
