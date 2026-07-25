import {
  allowedPayoutTransitions,
  calculatePayoutBreakdown,
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
    /**
     * Bundles an affiliate's approved commissions into a payout.
     *
     * Everything happens inside one transaction, holding a Postgres advisory
     * lock keyed on the affiliate. The previous version read the commissions
     * *outside* the transaction, summed them, then claimed them inside it with
     * an `updateMany` filtered on `status: 'APPROVED'`. Two concurrent
     * requests both read the same set; the second `updateMany` matched zero
     * rows, but the payout row was still created with the full amount -- a
     * payout for money that was already in another payout.
     *
     * The amount is now derived from the rows actually claimed, so it cannot
     * describe money this payout does not own.
     */
    async requestPayout(
      affiliateId: string,
      method: 'stripe_connect' | 'paypal' | 'manual',
      opts: { idempotencyKey?: string } = {}
    ) {
      if (opts.idempotencyKey) {
        const existing = await payouts.findByIdempotencyKey(
          affiliateId,
          opts.idempotencyKey
        );
        // A client that retries after a timeout gets the payout its first
        // attempt created, rather than a second one for the same money.
        if (existing) return toPayoutResponse(existing);
      }

      return prisma.$transaction(async (tx) => {
        // Serialises payout requests per affiliate for the life of this
        // transaction. Two requests for the same affiliate queue; requests for
        // different affiliates do not block each other. Released automatically
        // on commit or rollback, so a crash cannot strand the lock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${affiliateId}`}))`;

        const open = await tx.payout.findFirst({
          where: { affiliateId, status: { in: ['PENDING', 'PROCESSING'] } },
          select: { id: true, status: true },
        });
        if (open) {
          throw Errors.invalidRequest(
            'PAYOUT_IN_FLIGHT',
            `You already have a payout ${open.status.toLowerCase()}. ` +
              `Wait for it to settle before requesting another.`,
            { payoutId: open.id }
          );
        }

        const approved = await tx.commission.findMany({
          where: { affiliateId, status: 'APPROVED' },
          select: { id: true, amount: true, createdAt: true },
        });
        if (approved.length === 0) {
          throw Errors.badRequest('No approved commissions to pay out');
        }

        const commissionTotal = approved.reduce((sum, c) => sum + Number(c.amount), 0);

        // Unsettled clawbacks are netted off before anything else. A refund on
        // an already-paid commission cannot be undone by changing a status, so
        // it waits here as a negative adjustment until the next payout.
        const adjustments = await tx.balanceAdjustment.findMany({
          where: { affiliateId, settledPayoutId: null },
          select: { id: true, amount: true },
        });
        const adjustmentTotal = adjustments.reduce(
          (sum, a) => sum + Number(a.amount),
          0
        );

        const gross = Math.max(0, commissionTotal + adjustmentTotal);
        if (gross < MINIMUM_PAYOUT_AMOUNT) {
          throw Errors.badRequest(
            adjustmentTotal < 0
              ? `Below minimum payout of $${MINIMUM_PAYOUT_AMOUNT} after ` +
                  `$${Math.abs(adjustmentTotal).toFixed(2)} of pending clawbacks`
              : `Below minimum payout of $${MINIMUM_PAYOUT_AMOUNT}`
          );
        }

        const breakdown = calculatePayoutBreakdown(gross, env.PLATFORM_FEE_PERCENT);
        const dates = approved.map((c) => c.createdAt.getTime());

        const payout = await tx.payout.create({
          data: {
            affiliateId,
            amount: breakdown.gross,
            feeAmount: breakdown.fee,
            netAmount: breakdown.net,
            currency: 'USD',
            method: method.toUpperCase() as 'STRIPE_CONNECT' | 'PAYPAL' | 'MANUAL',
            status: 'PENDING',
            periodStart: new Date(Math.min(...dates)),
            periodEnd: new Date(Math.max(...dates)),
            idempotencyKey: opts.idempotencyKey ?? null,
          },
        });

        const claimed = await tx.commission.updateMany({
          where: {
            id: { in: approved.map((c) => c.id) },
            affiliateId,
            status: 'APPROVED',
          },
          data: { status: 'INCLUDED_IN_PAYOUT', payoutId: payout.id },
        });

        // Under the advisory lock this should be impossible. Checking anyway
        // means that if the lock is ever removed or a path bypasses it, the
        // transaction rolls back instead of creating a payout for money it
        // does not own.
        if (claimed.count !== approved.length) {
          throw Errors.conflict(
            'Commissions changed while the payout was being created'
          );
        }

        // Mark the adjustments settled inside the same transaction, so a
        // clawback is netted off exactly once. Applying it and forgetting to
        // mark it would deduct the same refund from every future payout.
        if (adjustments.length > 0) {
          await tx.balanceAdjustment.updateMany({
            where: { id: { in: adjustments.map((a) => a.id) } },
            data: { settledPayoutId: payout.id },
          });
        }

        await tx.payoutEvent.create({
          data: {
            payoutId: payout.id,
            fromStatus: 'PENDING',
            toStatus: 'PENDING',
            actorId: affiliateId,
            reason: `Requested by affiliate (${claimed.count} commissions)`,
          },
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
      const [pending, locked, approved, inPayout, paid, adjustments] =
        await Promise.all([
          commissions.sumByStatus(affiliateId, 'PENDING'),
          commissions.sumByStatus(affiliateId, 'LOCKED'),
          commissions.sumByStatus(affiliateId, 'APPROVED'),
          commissions.sumByStatus(affiliateId, 'INCLUDED_IN_PAYOUT'),
          commissions.sumByStatus(affiliateId, 'PAID'),
          prisma.balanceAdjustment.aggregate({
            _sum: { amount: true },
            where: { affiliateId, settledPayoutId: null },
          }),
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
        // Negative when refunds are waiting to be netted off. Shown so an
        // affiliate whose next payout is smaller than expected can see why.
        pendingAdjustments: money(adjustments._sum.amount),
      };
    },
  };
}
