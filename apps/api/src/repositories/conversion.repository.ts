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

    /**
     * The same list, seeked rather than offset.
     *
     * `(occurredAt, id)` is compared as a row value, which is exactly the
     * lexicographic semantics wanted and why this is one condition instead of
     * the `(a < x) OR (a = x AND b < y)` sprawl people usually write. `id`
     * breaks ties: `occurredAt` is not unique, and without a total order two
     * rows sharing a millisecond can swap places between requests -- so a
     * cursor pointing at either of them would be ambiguous.
     *
     * Takes `take + 1` so the caller can tell whether another page exists
     * without a second `COUNT(*)`, which on a large table costs more than the
     * page itself.
     */
    seekForBrandReview: (
      brandId: string,
      opts: { status?: string; take: number; after?: { occurredAt: Date; id: string } }
    ) =>
      db.conversion.findMany({
        where: {
          campaign: { brandId },
          ...(opts.status ? { status: opts.status as any } : {}),
          ...(opts.after
            ? {
                OR: [
                  { occurredAt: { lt: opts.after.occurredAt } },
                  { occurredAt: opts.after.occurredAt, id: { lt: opts.after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: opts.take + 1,
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
