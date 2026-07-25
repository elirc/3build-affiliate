import type { DB } from '../config/prisma';
import type { Prisma } from '@prisma/client';

export function campaignRepository(db: DB) {
  return {
    create: (data: Prisma.CampaignUncheckedCreateInput) =>
      db.campaign.create({ data }),

    findById: (id: string) => db.campaign.findUnique({ where: { id } }),

    findBySlug: (slug: string) => db.campaign.findUnique({ where: { slug } }),

    update: (id: string, data: Prisma.CampaignUncheckedUpdateInput) =>
      db.campaign.update({ where: { id }, data }),

    listByBrand: (
      brandId: string,
      opts: { status?: string; search?: string; skip: number; take: number }
    ) =>
      db.campaign.findMany({
        where: {
          brandId,
          ...(opts.status ? { status: opts.status as any } : {}),
          ...(opts.search
            ? { name: { contains: opts.search, mode: 'insensitive' } }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
      }),

    countByBrand: (brandId: string, opts: { status?: string; search?: string }) =>
      db.campaign.count({
        where: {
          brandId,
          ...(opts.status ? { status: opts.status as any } : {}),
          ...(opts.search
            ? { name: { contains: opts.search, mode: 'insensitive' } }
            : {}),
        },
      }),

    /**
     * Campaigns this affiliate may build links on right now: ACTIVE, and
     * belonging to a brand that has already approved them.
     *
     * Filtering by the relationship in SQL rather than fetching all active
     * campaigns and filtering in JS keeps the "are they approved?" rule in one
     * place, and means the picker cannot show something the API would refuse.
     */
    listEligibleForAffiliate: (affiliateId: string) =>
      db.campaign.findMany({
        where: {
          status: 'ACTIVE',
          brand: {
            brandRelations: { some: { affiliateId, status: 'APPROVED' } },
          },
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          allowedDomains: true,
          landingPageUrl: true,
          commissionStructure: true,
          brand: { select: { id: true, companyName: true } },
        },
      }),

    listOpenForAffiliates: (opts: { skip: number; take: number }) =>
      db.campaign.findMany({
        where: { status: 'ACTIVE', isOpen: true },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          brand: { select: { id: true, companyName: true, companyLogo: true } },
        },
      }),
  };
}
