import type { DB } from '../config/prisma';
import type { Prisma } from '@prisma/client';

export function commissionRepository(db: DB) {
  return {
    create: (data: Prisma.CommissionUncheckedCreateInput) =>
      db.commission.create({ data }),

    listForAffiliate: (
      affiliateId: string,
      opts: { status?: string; skip: number; take: number }
    ) =>
      db.commission.findMany({
        where: {
          affiliateId,
          ...(opts.status ? { status: opts.status as any } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          campaign: { select: { id: true, name: true } },
          conversion: { select: { id: true, externalOrderId: true, conversionValue: true } },
        },
      }),

    sumByStatus: (affiliateId: string, status: string) =>
      db.commission.aggregate({
        _sum: { amount: true },
        where: { affiliateId, status: status as any },
      }),

    listLockExpiringBefore: (date: Date) =>
      db.commission.findMany({
        where: { status: 'LOCKED', lockExpiresAt: { lte: date } },
      }),

    bulkSetStatus: (ids: string[], status: string, payoutId?: string) =>
      db.commission.updateMany({
        where: { id: { in: ids } },
        data: { status: status as any, ...(payoutId ? { payoutId } : {}) },
      }),

    listApprovedForAffiliate: (affiliateId: string) =>
      db.commission.findMany({
        where: { affiliateId, status: 'APPROVED' },
      }),
  };
}
