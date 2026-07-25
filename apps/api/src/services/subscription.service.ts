import { calculateCommission } from '@affiliate/analytics';
import type { CommissionStructure, RecurringBillingInput } from '@affiliate/shared';
import { Errors } from '../lib/errors';
import { money } from '../lib/money';
import { campaignRepository } from '../repositories/campaign.repository';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';

/**
 * Recurring commissions.
 *
 * `calculateCommission` treated `recurring` exactly like `percentage` and
 * ignored `recurringMonths` entirely, so a campaign promising "30% for twelve
 * months" paid 30% once. This is the machinery that makes the promise true.
 *
 * Subsequent billing events skip attribution altogether: which affiliate
 * earned this customer was settled by the first sale, and re-running
 * attribution months later would find no click and credit nobody.
 */
export function subscriptionService() {
  const campaigns = campaignRepository(prisma);

  return {
    /**
     * Records a subsequent billing period for an existing subscription.
     *
     * Returns `{ skipped }` rather than an error when the term is over or the
     * subscription was cancelled. A brand's billing system should not have to
     * track our counter to know whether to send us an event -- making them
     * mirror our state is how the two drift apart.
     */
    async recordBillingPeriod(campaignId: string, input: RecurringBillingInput) {
      const campaign = await campaigns.findById(campaignId);
      if (!campaign) throw Errors.notFound('Campaign');

      const subscription = await prisma.subscription.findUnique({
        where: {
          campaignId_externalReference: {
            campaignId,
            externalReference: input.externalReference,
          },
        },
      });
      if (!subscription) throw Errors.notFound('Subscription');

      if (subscription.status === 'CANCELLED') {
        return { skipped: 'cancelled' as const };
      }
      if (subscription.completedPeriods >= subscription.totalPeriods) {
        // Mark it done if it is not already, so the next event is cheap.
        if (subscription.status !== 'COMPLETED') {
          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: 'COMPLETED' },
          });
        }
        return { skipped: 'term_complete' as const };
      }

      const period = subscription.completedPeriods + 1;
      const externalOrderId = `${input.externalReference}:m${period}`;

      const duplicate = await prisma.conversion.findFirst({
        where: { campaignId, externalOrderId },
      });
      if (duplicate) {
        // A billing webhook that retries must not pay twice.
        throw Errors.conflict(`Period ${period} has already been recorded`);
      }

      // The snapshot, not the campaign's current terms.
      const structure = subscription.commissionSnapshot as unknown as CommissionStructure;
      const commissionAmount = calculateCommission(structure, Number(input.amount));

      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      const lockExpiresAt = new Date(
        occurredAt.getTime() + campaign.lockPeriodDays * 86400 * 1000
      );

      return prisma.$transaction(async (tx) => {
        const conversion = await tx.conversion.create({
          data: {
            trackingLinkId: subscription.trackingLinkId,
            campaignId,
            affiliateId: subscription.affiliateId,
            externalOrderId,
            conversionValue: money(input.amount),
            commissionAmount: commissionAmount.toFixed(2),
            // Recurring periods still go through brand review and the lock
            // period: a subscription can be refunded like anything else.
            status: 'PENDING',
            customerEmailHash: subscription.customerEmailHash,
            isFirstTimeCustomer: false,
            occurredAt,
          },
        });

        await tx.commission.create({
          data: {
            affiliateId: subscription.affiliateId,
            campaignId,
            conversionId: conversion.id,
            amount: commissionAmount.toFixed(2),
            status: 'LOCKED',
            lockExpiresAt,
          },
        });

        await tx.trackingLink.update({
          where: { id: subscription.trackingLinkId },
          data: {
            conversionCount: { increment: 1 },
            revenue: { increment: Number(input.amount) },
          },
        });

        const updated = await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            completedPeriods: period,
            status:
              period >= subscription.totalPeriods ? 'COMPLETED' : 'ACTIVE',
          },
        });

        return {
          conversionId: conversion.id,
          period,
          remainingPeriods: updated.totalPeriods - updated.completedPeriods,
          commissionAmount: commissionAmount.toFixed(2),
        };
      });
    },

    /**
     * Stops future commissions. Already-earned ones are untouched -- the
     * affiliate did that work and the customer paid for those months.
     */
    async cancel(campaignId: string, externalReference: string) {
      const subscription = await prisma.subscription.findUnique({
        where: { campaignId_externalReference: { campaignId, externalReference } },
      });
      if (!subscription) throw Errors.notFound('Subscription');

      if (subscription.status === 'CANCELLED') {
        return { alreadyCancelled: true, id: subscription.id };
      }

      const updated = await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      return { alreadyCancelled: false, id: updated.id };
    },

    async listForAffiliate(affiliateId: string) {
      return prisma.subscription.findMany({
        where: { affiliateId },
        orderBy: { startedAt: 'desc' },
        include: { campaign: { select: { id: true, name: true } } },
      });
    },

    /**
     * Called after a first sale on a recurring campaign.
     *
     * Failures are logged rather than thrown: the conversion itself is already
     * committed and valid, and refusing it because the subscription row could
     * not be written would lose a real sale over bookkeeping.
     */
    async startIfRecurring(args: {
      campaignId: string;
      affiliateId: string;
      trackingLinkId: string;
      conversionId: string;
      externalReference: string;
      customerEmailHash: string | null;
      structure: CommissionStructure;
    }) {
      if (args.structure.type !== 'recurring') return null;

      try {
        return await prisma.subscription.create({
          data: {
            campaignId: args.campaignId,
            affiliateId: args.affiliateId,
            trackingLinkId: args.trackingLinkId,
            originalConversionId: args.conversionId,
            externalReference: args.externalReference,
            customerEmailHash: args.customerEmailHash,
            commissionSnapshot: args.structure as unknown as object,
            totalPeriods: args.structure.recurringMonths,
            // The first sale is period one; it produced a commission already.
            completedPeriods: 1,
            status: args.structure.recurringMonths <= 1 ? 'COMPLETED' : 'ACTIVE',
          },
        });
      } catch (err) {
        logger.error(
          { err, conversionId: args.conversionId },
          'Failed to start subscription for a recurring conversion'
        );
        return null;
      }
    },
  };
}
