import type { DB } from '../config/prisma';
import type { Prisma } from '@prisma/client';

export function trackingLinkRepository(db: DB) {
  return {
    create: (data: Prisma.TrackingLinkUncheckedCreateInput) =>
      db.trackingLink.create({ data }),

    findByShortCode: (shortCode: string) =>
      db.trackingLink.findUnique({ where: { shortCode } }),

    findById: (id: string) => db.trackingLink.findUnique({ where: { id } }),

    listByAffiliate: (affiliateId: string) =>
      db.trackingLink.findMany({
        where: { affiliateId },
        orderBy: { createdAt: 'desc' },
        include: { campaign: { select: { id: true, name: true } } },
      }),

    countForAffiliateOnCampaign: (affiliateId: string, campaignId: string) =>
      db.trackingLink.count({ where: { affiliateId, campaignId } }),

    setActive: (id: string, isActive: boolean) =>
      db.trackingLink.update({ where: { id }, data: { isActive } }),
  };
}
