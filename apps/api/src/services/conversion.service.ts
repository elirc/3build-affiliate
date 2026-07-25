import {
  acceptsConversions,
  attribute,
  calculateCommission,
  calculateRefund,
} from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import { hashEmail } from '../lib/hash';
import type {
  CommissionStructure,
  ReportConversionInput,
  ReverseConversionInput,
  ReviewConversionInput,
} from '@affiliate/shared';
import { conversionRepository } from '../repositories/conversion.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { fraudService } from './fraud.service';
import { prisma } from '../config/prisma';

export function conversionService() {
  const conversions = conversionRepository(prisma);
  const campaigns = campaignRepository(prisma);
  const fraud = fraudService();

  return {
    /**
     * Brand reports a conversion (server-to-server, called from their store
     * after a purchase). We look up the attribution cookie's recent clicks,
     * apply the attribution model, and create one Commission per share.
     */
    async report(campaignId: string, input: ReportConversionInput) {
      const campaign = await campaigns.findById(campaignId);
      if (!campaign) throw Errors.notFound('Campaign');

      // PAUSED still accepts sales: a conversion can legitimately land days
      // after the click that earned it, and refusing those would quietly rob
      // affiliates of commission they had already earned. ENDED does not --
      // that is what ending a campaign means.
      if (!acceptsConversions(campaign.status)) {
        throw Errors.unprocessable(
          `Campaign is ${campaign.status.toLowerCase()} and no longer accepts conversions`
        );
      }

      const duplicate = await prisma.conversion.findFirst({
        where: {
          campaignId,
          OR: [
            { externalOrderId: input.externalOrderId },
            { externalOrderId: { startsWith: `${input.externalOrderId}:` } },
          ],
        },
      });
      if (duplicate) throw Errors.conflict('Conversion with this order id already exists');

      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
      const windowMs = campaign.attributionWindowDays * 86400 * 1000;
      const windowStart = new Date(occurredAt.getTime() - windowMs);

      const clicks = input.attributionCookieId
        ? await prisma.clickEvent.findMany({
            where: {
              attributionCookieId: input.attributionCookieId,
              timestamp: { gte: windowStart, lte: occurredAt },
              trackingLink: { campaignId },
            },
            select: {
              id: true,
              trackingLinkId: true,
              timestamp: true,
              trackingLink: { select: { affiliateId: true } },
            },
            orderBy: { timestamp: 'asc' },
          })
        : [];

      if (clicks.length === 0) {
        throw Errors.unprocessable(
          'No attributable clicks found within the attribution window'
        );
      }

      const shares = attribute(
        campaign.attributionModel,
        clicks.map((c) => ({
          trackingLinkId: c.trackingLinkId,
          affiliateId: c.trackingLink.affiliateId,
          timestamp: c.timestamp.getTime(),
        }))
      );

      const created = await prisma.$transaction(async (tx) => {
        const records: {
          conversionId: string;
          commissionId: string;
          affiliateId: string;
          trackingLinkId: string;
        }[] = [];

        for (const share of shares) {
          const priorCount = await tx.conversion.count({
            where: { affiliateId: share.affiliateId, campaignId, status: 'APPROVED' },
          });
          const splitValue = Number(input.conversionValue) * share.share;
          const commissionAmount = calculateCommission(
            campaign.commissionStructure as unknown as CommissionStructure,
            splitValue,
            priorCount
          );

          const conv = await tx.conversion.create({
            data: {
              trackingLinkId: share.trackingLinkId,
              campaignId,
              affiliateId: share.affiliateId,
              clickEventId:
                clicks.find((c) => c.trackingLinkId === share.trackingLinkId)?.id ??
                null,
              externalOrderId:
                input.externalOrderId +
                (shares.length > 1 ? `:${share.affiliateId}` : ''),
              conversionValue: splitValue.toFixed(2),
              commissionAmount: commissionAmount.toFixed(2),
              status: 'PENDING',
              customerEmailHash: input.customerEmail
                ? hashEmail(input.customerEmail)
                : null,
              isFirstTimeCustomer: input.isFirstTimeCustomer,
              occurredAt,
            },
          });

          const lockExpiresAt = new Date(
            occurredAt.getTime() + campaign.lockPeriodDays * 86400 * 1000
          );
          const com = await tx.commission.create({
            data: {
              affiliateId: share.affiliateId,
              campaignId,
              conversionId: conv.id,
              amount: commissionAmount.toFixed(2),
              status: 'LOCKED',
              lockExpiresAt,
            },
          });

          await tx.trackingLink.update({
            where: { id: share.trackingLinkId },
            data: {
              conversionCount: { increment: 1 },
              revenue: { increment: splitValue },
            },
          });

          records.push({
            conversionId: conv.id,
            commissionId: com.id,
            affiliateId: share.affiliateId,
            trackingLinkId: share.trackingLinkId,
          });
        }

        return records;
      });

      await Promise.all(
        created.map((record) => {
          return fraud.evaluate({
            conversionId: record.conversionId,
            affiliateId: record.affiliateId,
            campaignId,
            attributionCookieId: input.attributionCookieId,
            clickTimestamps: clicks
              .filter((c) => c.trackingLinkId === record.trackingLinkId)
              .map((c) => c.timestamp.getTime()),
            conversionTimestamp: occurredAt.getTime(),
          });
        })
      );

      return { created };
    },

    async review(brandId: string, conversionId: string, input: ReviewConversionInput) {
      const conv = await conversions.findById(conversionId);
      if (!conv) throw Errors.notFound('Conversion');
      const campaign = await campaigns.findById(conv.campaignId);
      if (!campaign || campaign.brandId !== brandId) throw Errors.forbidden();
      if (conv.status !== 'PENDING') {
        throw Errors.badRequest('Conversion has already been reviewed');
      }
      const status = input.status === 'approved' ? 'APPROVED' : 'REJECTED';
      return prisma.$transaction(async (tx) => {
        const updated = await tx.conversion.update({
          where: { id: conversionId },
          data:
            status === 'APPROVED'
              ? { status, approvedAt: new Date() }
              : {
                  status,
                  rejectedAt: new Date(),
                  rejectionReason: input.reason,
                },
        });

        if (status === 'REJECTED') {
          await tx.commission.updateMany({
            where: { conversionId },
            data: { status: 'REJECTED' },
          });
        } else {
          await tx.commission.updateMany({
            where: { conversionId, lockExpiresAt: { lte: new Date() } },
            data: { status: 'APPROVED', approvedAt: new Date() },
          });
        }

        return updated;
      });
    },

    /**
     * Reverses an approved conversion, in whole or in part.
     *
     * The lock period exists precisely so that a refund arriving after
     * approval can still be handled. What happens depends on how far the
     * commission has already travelled, and the interesting case is the last
     * one: money that has already been paid cannot be un-paid by changing a
     * status, so it becomes a negative balance adjustment netted off the
     * affiliate's next payout.
     */
    async reverse(
      brandId: string,
      conversionId: string,
      input: ReverseConversionInput
    ) {
      const conv = await conversions.findById(conversionId);
      if (!conv) throw Errors.notFound('Conversion');

      const campaign = await campaigns.findById(conv.campaignId);
      if (!campaign || campaign.brandId !== brandId) throw Errors.forbidden();

      if (conv.status !== 'APPROVED') {
        throw Errors.badRequest(
          conv.status === 'REJECTED'
            ? 'This conversion has already been reversed or rejected'
            : 'Only an approved conversion can be reversed. Reject it instead.'
        );
      }

      const originalValue = Number(conv.conversionValue);
      const originalCommission = Number(conv.commissionAmount);
      const refundAmount = input.refundAmount ?? originalValue;

      let outcome;
      try {
        outcome = calculateRefund(originalValue, originalCommission, refundAmount);
      } catch (err) {
        throw Errors.badRequest((err as Error).message);
      }

      const commission = await prisma.commission.findFirst({
        where: { conversionId },
      });
      if (!commission) throw Errors.notFound('Commission');

      // A commission already committed to an unsettled payout is the one case
      // we refuse. Editing it would change an amount an admin is in the middle
      // of transferring; the brand should wait for the payout to settle or
      // fail, at which point the normal paths apply.
      if (commission.status === 'INCLUDED_IN_PAYOUT') {
        throw Errors.invalidRequest(
          'COMMISSION_IN_PAYOUT',
          'This commission is part of a payout that has not settled yet. ' +
            'Try again once the payout has completed or failed.'
        );
      }

      return prisma.$transaction(async (tx) => {
        await tx.conversion.update({
          where: { id: conversionId },
          data: outcome.isFullRefund
            ? {
                status: 'REJECTED',
                rejectedAt: new Date(),
                rejectionReason: input.reason,
              }
            : {
                // A partial refund leaves a real sale in place, so the
                // conversion stays APPROVED with reduced figures rather than
                // disappearing from the affiliate's history.
                conversionValue: outcome.remainingValue,
                commissionAmount: outcome.remainingCommission,
                notes: input.reason,
              },
        });

        if (commission.status === 'PAID') {
          // The money is gone. Record what is owed back instead of pretending
          // the commission was never paid.
          await tx.balanceAdjustment.create({
            data: {
              affiliateId: conv.affiliateId,
              amount: `-${outcome.clawbackAmount}`,
              reason: `Refund on order ${conv.externalOrderId}: ${input.reason}`,
              conversionId,
            },
          });
        } else if (outcome.isFullRefund) {
          await tx.commission.update({
            where: { id: commission.id },
            data: { status: 'CLAWED_BACK' },
          });
        } else {
          await tx.commission.update({
            where: { id: commission.id },
            data: { amount: outcome.remainingCommission },
          });
        }

        // Keep the denormalised counters honest. They are eventually
        // consistent, not wrong.
        await tx.trackingLink.update({
          where: { id: conv.trackingLinkId },
          data: {
            revenue: { decrement: Number(refundAmount) },
            ...(outcome.isFullRefund ? { conversionCount: { decrement: 1 } } : {}),
          },
        });

        return {
          conversionId,
          ...outcome,
          clawbackMethod: commission.status === 'PAID' ? 'balance_adjustment' : 'commission',
        };
      });
    },

    async listForBrand(
      brandId: string,
      opts: { status?: string; page: number; pageSize: number }
    ) {
      const skip = (opts.page - 1) * opts.pageSize;
      return conversions.listForBrandReview(brandId, {
        status: opts.status,
        skip,
        take: opts.pageSize,
      });
    },
  };
}
