import {
  allowedPayoutTransitions,
  canTransitionPayout,
  releasesCommissions,
  settlesCommissions,
  type PayoutStatusUpper,
} from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import { money } from '../lib/money';
import { MINIMUM_PAYOUT_AMOUNT } from '@affiliate/shared';
import type { Payout } from '@prisma/client';
import { commissionRepository } from '../repositories/commission.repository';
import { payoutRepository } from '../repositories/payout.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

/**
 * Payout as it goes over the wire.
 *
 * Prisma's Decimal serialises to the shortest form ("120" for 120.00), so
 * every money field is formatted explicitly on the way out. See lib/money.ts.
 */
function toPayoutResponse(payout: Payout) {
  return {
    ...payout,
    amount: money(payout.amount),
    feeAmount: money(payout.feeAmount),
    netAmount: money(payout.netAmount),
  };
}

export function payoutService() {
  const commissions = commissionRepository(prisma);
  const payouts = payoutRepository(prisma);

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
        throw Errors.badRequest(`Below minimum payout of $${MINIMUM_PAYOUT_AMOUNT}`);
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
            method: method.toUpperCase() as 'STRIPE_CONNECT' | 'PAYPAL' | 'MANUAL',
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

        return toPayoutResponse(payout);
      });
    },

    /**
     * Moves a payout to a new state, adjusts the attached commissions to
     * match, and records who did it -- all in one transaction.
     *
     * The three effects belong together. A payout marked PAID whose
     * commissions are still INCLUDED_IN_PAYOUT would show an affiliate money
     * that has left the platform but never arrived in their lifetime total;
     * a payout released without its commissions going back to APPROVED makes
     * an affiliate's balance vanish.
     */
    async transition(
      payoutId: string,
      to: PayoutStatusUpper,
      opts: { actorId: string; reason?: string; reference?: string }
    ) {
      const payout = await payouts.findById(payoutId);
      if (!payout) throw Errors.notFound('Payout');

      const from = payout.status as PayoutStatusUpper;
      if (!canTransitionPayout(from, to)) {
        throw Errors.invalidRequest(
          'INVALID_TRANSITION',
          `Cannot move a payout from ${from} to ${to}`,
          { from, to, allowed: allowedPayoutTransitions(from) }
        );
      }

      if (to === 'FAILED' && !opts.reason) {
        // An unexplained failure is unactionable: nobody can tell whether to
        // retry it, fix a bank detail, or contact the affiliate.
        throw Errors.badRequest('A reason is required when failing a payout');
      }

      return prisma.$transaction(async (tx) => {
        const updated = await tx.payout.update({
          where: { id: payoutId },
          data: {
            status: to,
            ...(settlesCommissions(to) ? { paidAt: new Date() } : {}),
            ...(to === 'FAILED' ? { failureReason: opts.reason } : {}),
            ...(opts.reference ? { stripeTransferId: opts.reference } : {}),
          },
        });

        if (settlesCommissions(to)) {
          await tx.commission.updateMany({
            where: { payoutId, status: 'INCLUDED_IN_PAYOUT' },
            data: { status: 'PAID', paidAt: new Date() },
          });
        }

        if (releasesCommissions(to)) {
          // The money never left, so this work is owed again. Detaching the
          // payoutId is what makes them eligible for a later request.
          await tx.commission.updateMany({
            where: { payoutId, status: 'INCLUDED_IN_PAYOUT' },
            data: { status: 'APPROVED', payoutId: null },
          });
        }

        await tx.payoutEvent.create({
          data: {
            payoutId,
            fromStatus: from,
            toStatus: to,
            actorId: opts.actorId,
            reason: opts.reason ?? null,
            reference: opts.reference ?? null,
          },
        });

        return toPayoutResponse(updated);
      });
    },

    async listForAffiliate(
      affiliateId: string,
      opts: { page: number; pageSize: number }
    ) {
      const skip = (opts.page - 1) * opts.pageSize;
      const [items, total] = await Promise.all([
        payouts.listForAffiliate(affiliateId, { skip, take: opts.pageSize }),
        payouts.countForAffiliate(affiliateId),
      ]);
      return {
        items: items.map((p) => ({ ...toPayoutResponse(p), commissions: p.commissions })),
        total,
        page: opts.page,
        pageSize: opts.pageSize,
      };
    },

    async listForAdmin(opts: { status?: string; page: number; pageSize: number }) {
      const skip = (opts.page - 1) * opts.pageSize;
      return payouts.listForAdmin({
        status: opts.status,
        skip,
        take: opts.pageSize,
      });
    },

    async history(payoutId: string) {
      const payout = await payouts.findById(payoutId);
      if (!payout) throw Errors.notFound('Payout');
      return payouts.listEvents(payoutId);
    },

    async summary(affiliateId: string) {
      const [pending, locked, approved, inPayout, paid] = await Promise.all([
        commissions.sumByStatus(affiliateId, 'PENDING'),
        commissions.sumByStatus(affiliateId, 'LOCKED'),
        commissions.sumByStatus(affiliateId, 'APPROVED'),
        commissions.sumByStatus(affiliateId, 'INCLUDED_IN_PAYOUT'),
        commissions.sumByStatus(affiliateId, 'PAID'),
      ]);
      const num = (v: { _sum: { amount: unknown } }) =>
        Number(v._sum.amount ?? 0).toFixed(2);
      return {
        pending: num(pending),
        locked: num(locked),
        approved: num(approved),
        // Money committed to a payout that has not settled yet. Without this
        // the balance appears to drop to zero the moment a payout is
        // requested, which reads as money going missing.
        inPayout: num(inPayout),
        paid: num(paid),
      };
    },
  };
}
