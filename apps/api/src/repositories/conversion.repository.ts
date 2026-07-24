import type { DB } from '../config/prisma';
import type { Prisma } from '@prisma/client';

export function conversionRepository(db: DB) {
  return {
    create: (data: Prisma.ConversionUncheckedCreateInput) =>
      db.conversion.create({ data }),

    findByExternalOrder: (campaignId: string, externalOrderId: string) =>
      db.conversion.findUnique({
        where: { campaignId_externalOrderId: { campaignId, externalOrderId } },
      }),

    findById: (id: string) => db.conversion.findUnique({ where: { id } }),

    listForBrandReview: (
      brandId: string,
      opts: { status?: string; skip: number; take: number }
    ) =>
      db.conversion.findMany({
        where: {
          campaign: { brandId },
          ...(opts.status ? { status: opts.status as any } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          campaign: { select: { id: true, name: true } },
          affiliate: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),

    countPriorApprovedForAffiliate: (affiliateId: string, campaignId: string) =>
      db.conversion.count({
        where: { affiliateId, campaignId, status: 'APPROVED' },
      }),

    setStatus: (
      id: string,
      status: 'APPROVED' | 'REJECTED',
      data: { rejectionReason?: string }
    ) =>
      db.conversion.update({
        where: { id },
        data: {
          status,
          ...(status === 'APPROVED'
            ? { approvedAt: new Date() }
            : { rejectedAt: new Date(), rejectionReason: data.rejectionReason }),
        },
      }),
  };
}
