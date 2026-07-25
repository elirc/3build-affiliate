import type { DB } from '../config/prisma';
import type { PayoutStatusUpper } from '@affiliate/analytics';

export function payoutRepository(db: DB) {
  return {
    findById: (id: string) => db.payout.findUnique({ where: { id } }),

    /**
     * A payout with enough context to be useful on screen: how many
     * commissions it covers and which campaigns they came from. An affiliate
     * looking at "$412.50, paid" almost always wants to know what it was for.
     */
    listForAffiliate: (
      affiliateId: string,
      opts: { skip: number; take: number }
    ) =>
      db.payout.findMany({
        where: { affiliateId },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          commissions: {
            select: { id: true, amount: true, campaign: { select: { name: true } } },
          },
        },
      }),

    countForAffiliate: (affiliateId: string) =>
      db.payout.count({ where: { affiliateId } }),

    listForAdmin: (opts: { status?: string; skip: number; take: number }) =>
      db.payout.findMany({
        where: opts.status ? { status: opts.status as PayoutStatusUpper } : {},
        orderBy: { createdAt: 'asc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          affiliate: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              stripeConnectAccountId: true,
            },
          },
          _count: { select: { commissions: true } },
        },
      }),

    hasOpenPayout: (affiliateId: string) =>
      db.payout.findFirst({
        where: { affiliateId, status: { in: ['PENDING', 'PROCESSING'] } },
        select: { id: true, status: true },
      }),

    listEvents: (payoutId: string) =>
      db.payoutEvent.findMany({
        where: { payoutId },
        orderBy: { createdAt: 'asc' },
        include: {
          actor: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
  };
}
