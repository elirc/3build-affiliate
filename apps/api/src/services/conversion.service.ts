import {
  acceptsConversions,
  attribute,
  calculateCommission,
  calculateRefund,
  resolveCommissionStructure,
} from '@affiliate/analytics';
import {
  InvalidCursorError,
  commissionStructureSchema,
  decodeCursor,
  toCursorPage,
} from '@affiliate/shared';
import { Prisma } from '@prisma/client';
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
import { subscriptionService } from './subscription.service';
import { enqueueNotification } from './notification.service';
import { prisma } from '../config/prisma';

/**
 * customCommission is a JSON column, so its contents are not guaranteed by the
 * database. Validating with the same schema the write path uses means a bad
 * row degrades to the campaign default rather than throwing mid-transaction.
 */
function isCommissionStructure(value: unknown): value is CommissionStructure {
  return commissionStructureSchema.safeParse(value).success;
}

export function conversionService() {
  const conversions = conversionRepository(prisma);
  const campaigns = campaignRepository(prisma);
  const fraud = fraudService();
  const subscriptions = subscriptionService();

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
              // A crawler must never earn anyone a commission. Without this, a
              // bot that happened to touch a link inside the window could be
              // the click a real sale is attributed to.
              isCounted: true,
            },
            select: {
              id: true,
              trackingLinkId: true,
              timestamp: true,
              subIds: true,
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
          structure: CommissionStructure;
        }[] = [];

        for (const share of shares) {
          const priorCount = await tx.conversion.count({
            where: { affiliateId: share.affiliateId, campaignId, status: 'APPROVED' },
          });

          // Read inside the transaction so the rate reflects the moment the
          // sale is recorded, not whatever it was when the request arrived.
          const relationship = await tx.brandAffiliate.findUnique({
            where: {
              brandId_affiliateId: {
                brandId: campaign.brandId,
                affiliateId: share.affiliateId,
              },
            },
            select: { status: true, customCommission: true },
          });

          const { structure } = resolveCommissionStructure(
            campaign.commissionStructure as unknown as CommissionStructure,
            relationship,
            isCommissionStructure
          );

          const attributedClick = clicks.find(
            (c) => c.trackingLinkId === share.trackingLinkId
          );
          const splitValue = Number(input.conversionValue) * share.share;
          const commissionAmount = calculateCommission(
            structure,
            splitValue,
            priorCount
          );

          const conv = await tx.conversion.create({
            data: {
              trackingLinkId: share.trackingLinkId,
              campaignId,
              affiliateId: share.affiliateId,
              clickEventId: attributedClick?.id ?? null,
              // Copied from the click, so a placement stays attributable even
              // after click events are pruned.
              subIds: (attributedClick?.subIds as Prisma.InputJsonValue) ?? Prisma.DbNull,
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
            structure,
          });
        }

        return records;
      });

      // A recurring campaign promises future periods, so the first sale has to
      // leave something behind that remembers the terms and the count.
      await Promise.all(
        created.map((record) =>
          subscriptions.startIfRecurring({
            campaignId,
            affiliateId: record.affiliateId,
            trackingLinkId: record.trackingLinkId,
            conversionId: record.conversionId,
            externalReference: input.externalOrderId,
            customerEmailHash: input.customerEmail ? hashEmail(input.customerEmail) : null,
            structure: record.structure,
          })
        )
      );

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
        // Claim the conversion conditionally rather than updating by id.
        //
        // The PENDING check above happens outside this transaction, so two
        // simultaneous reviews -- an approve and a reject, or a double-clicked
        // button -- both passed it and both wrote, racing on the final state
        // and emitting two contradictory notifications. Requiring the row to
        // still be PENDING means exactly one of them wins and the other is
        // told why.
        //
        // A single-statement conditional update is enough here because the
        // transition is one-way; reversal needs a lock instead, because a
        // partial refund leaves the status unchanged.
        const claimed = await tx.conversion.updateMany({
          where: { id: conversionId, status: 'PENDING' },
          data:
            status === 'APPROVED'
              ? { status, approvedAt: new Date() }
              : {
                  status,
                  rejectedAt: new Date(),
                  rejectionReason: input.reason,
                },
        });

        if (claimed.count !== 1) {
          throw Errors.conflict('Conversion has already been reviewed');
        }

        const updated = await tx.conversion.findUniqueOrThrow({
          where: { id: conversionId },
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

        await enqueueNotification(tx, {
          userId: conv.affiliateId,
          type: status === 'APPROVED' ? 'conversion_approved' : 'conversion_rejected',
          payload: {
            conversionId,
            orderId: conv.externalOrderId,
            commission: String(conv.commissionAmount),
            reason: input.reason ?? null,
          },
        });

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
      // Ownership is checked before the transaction so a 403 never takes a
      // lock. Nothing else is decided out here.
      const owned = await conversions.findById(conversionId);
      if (!owned) throw Errors.notFound('Conversion');

      const campaign = await campaigns.findById(owned.campaignId);
      if (!campaign || campaign.brandId !== brandId) throw Errors.forbidden();

      return prisma.$transaction(async (tx) => {
        // Serialises reversals of this one conversion.
        //
        // Every check used to happen before the transaction and every write
        // by id inside it, so two concurrent refunds both read APPROVED, both
        // read the commission as PAID, and both wrote a negative balance
        // adjustment -- the same refund deducted twice from the affiliate's
        // next payout. A retried request was enough.
        //
        // A conditional claim on status fixes the *full* refund case, because
        // that moves APPROVED -> REJECTED. It does nothing for a partial
        // refund, which leaves the conversion APPROVED and would happily
        // reduce it twice. The lock covers both, and it is the same pattern
        // requestPayout already uses.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conversion-reverse:${conversionId}`}))`;

        // Re-read under the lock. Everything from here is decided on state
        // that cannot change underneath us.
        const conv = await tx.conversion.findUnique({ where: { id: conversionId } });
        if (!conv) throw Errors.notFound('Conversion');

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

        const commission = await tx.commission.findFirst({ where: { conversionId } });
        if (!commission) throw Errors.notFound('Commission');

        // A commission already committed to an unsettled payout is the one
        // case we refuse. Editing it would change an amount an admin is in
        // the middle of transferring; the brand should wait for the payout to
        // settle or fail, at which point the normal paths apply.
        if (commission.status === 'INCLUDED_IN_PAYOUT') {
          throw Errors.invalidRequest(
            'COMMISSION_IN_PAYOUT',
            'This commission is part of a payout that has not settled yet. ' +
              'Try again once the payout has completed or failed.'
          );
        }

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

        // Mandatory: a reversal takes back money the affiliate was already
        // told they had earned. A silent deduction destroys trust faster than
        // the deduction itself.
        await enqueueNotification(tx, {
          userId: conv.affiliateId,
          type: 'commission_clawed_back',
          payload: {
            conversionId,
            orderId: conv.externalOrderId,
            clawbackAmount: outcome.clawbackAmount,
            reason: input.reason,
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

    /**
     * Cursor-paged conversions.
     *
     * Offset paging over this list is not just slow, it is *wrong*: the order
     * is `occurredAt desc`, so conversions arriving between two page fetches
     * shift everything down and rows from page 1 reappear on page 2. A client
     * paging through everything to sum it gets a wrong number and no error.
     */
    async seekForBrand(
      brandId: string,
      opts: { status?: string; pageSize: number; cursor?: string }
    ) {
      let after: { occurredAt: Date; id: string } | undefined;

      if (opts.cursor) {
        try {
          const { sortValue, id } = decodeCursor(opts.cursor);
          const occurredAt = new Date(sortValue);
          if (Number.isNaN(occurredAt.getTime())) throw new InvalidCursorError();
          after = { occurredAt, id };
        } catch {
          // A cursor arrives from outside and is therefore untrusted. A
          // malformed one is the client's mistake to fix, not a 500.
          throw Errors.invalidRequest('INVALID_CURSOR', 'Cursor is not valid');
        }
      }

      const rows = await conversions.seekForBrandReview(brandId, {
        status: opts.status,
        take: opts.pageSize,
        after,
      });

      return toCursorPage(rows, opts.pageSize, (r) => r.occurredAt);
    },
  };
}
