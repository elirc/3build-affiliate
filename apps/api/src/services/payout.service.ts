import { Errors } from '../lib/errors';
import { MINIMUM_PAYOUT_AMOUNT } from '@affiliate/shared';
import { commissionRepository } from '../repositories/commission.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

export function payoutService() {
  const commissions = commissionRepository(prisma);

  return {
    async requestPayout(
      affiliateId: string,
      method: 'stripe_connect' | 'paypal' | 'manual'
    ) {
      const approved = await commissions.listApprovedForAffiliate(affiliateId);
      if (approved.length === 0) {
        throw Errors.badRequest('No approved commissions to pay out');
      }
      const gross = approved.reduce((sum, c) => sum + Number(c.amount), 0);
      if (gross < MINIMUM_PAYOUT_AMOUNT) {
        throw Errors.badRequest(
          `Below minimum payout of $${MINIMUM_PAYOUT_AMOUNT}`
        );
      }

      const fee = Math.round(gross * env.PLATFORM_FEE_PERCENT) / 100;
      const net = Math.round((gross - fee) * 100) / 100;

      const earliest = approved.reduce(
        (min, c) => (c.createdAt < min ? c.createdAt : min),
        approved[0]!.createdAt
      );
      const latest = approved.reduce(
        (max, c) => (c.createdAt > max ? c.createdAt : max),
        approved[0]!.createdAt
      );

      return prisma.$transaction(async (tx) => {
        const payout = await tx.payout.create({
          data: {
            affiliateId,
            amount: gross.toFixed(2),
            feeAmount: fee.toFixed(2),
            netAmount: net.toFixed(2),
            currency: 'USD',
            method: method.toUpperCase() as any,
            status: 'PENDING',
            periodStart: earliest,
            periodEnd: latest,
          },
        });

        await tx.commission.updateMany({
          where: {
            id: { in: approved.map((c) => c.id) },
            affiliateId,
            status: 'APPROVED',
          },
          data: { status: 'INCLUDED_IN_PAYOUT', payoutId: payout.id },
        });

        return payout;
      });
    },

    async summary(affiliateId: string) {
      const [pending, locked, approved, paid] = await Promise.all([
        commissions.sumByStatus(affiliateId, 'PENDING'),
        commissions.sumByStatus(affiliateId, 'LOCKED'),
        commissions.sumByStatus(affiliateId, 'APPROVED'),
        commissions.sumByStatus(affiliateId, 'PAID'),
      ]);
      const num = (v: { _sum: { amount: any } }) =>
        Number(v._sum.amount ?? 0).toFixed(2);
      return {
        pending: num(pending),
        locked: num(locked),
        approved: num(approved),
        paid: num(paid),
      };
    },
  };
}
