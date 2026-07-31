import type { FastifyInstance, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  csvDate,
  csvFilename,
  paginate,
  streamCsv,
  type CsvColumn,
} from '../lib/csv';
import { money } from '../lib/money';
import { prisma } from '../config/prisma';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const exportQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Exports are the same query the on-screen list uses, with a different
 * serialiser. Reusing the scoping is the point: an export that built its own
 * WHERE clause is an export that eventually forgets the brand id.
 */
function dateRange(q: { from?: string; to?: string }) {
  if (!q.from && !q.to) return {};
  return {
    occurredAt: {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    },
  };
}

function sendCsv(
  reply: FastifyReply,
  filename: string,
  chunks: AsyncGenerator<string>
) {
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  // Deliberately no Content-Length: the whole point is that we do not know it
  // without materialising the export first.
  return reply.send(Readable.from(chunks));
}

export async function exportRoutes(app: FastifyInstance) {
  /**
   * Exports are heavier than a page of results, so they get their own limit.
   * Generous enough for a finance team pulling several reports, tight enough
   * that nobody can loop it.
   */
  const exportRateLimit = {
    config: { rateLimit: { tier: 'authenticated', perMinute: 10, burst: 10 } },
  } as const;

  app.get(
    '/brand/conversions/export',
    {
      preHandler: [requireAuth, requireRole('BRAND')],
      ...exportRateLimit,
    },
    async (req, reply) => {
      const user = (req as AuthedRequest).user;
      const q = exportQuerySchema.parse(req.query);

      const where = {
        campaign: { brandId: user.id },
        ...(q.status ? { status: q.status } : {}),
        ...dateRange(q),
      };

      type Row = {
        externalOrderId: string;
        conversionValue: unknown;
        commissionAmount: unknown;
        status: string;
        occurredAt: Date;
        createdAt: Date;
        campaign: { name: string };
        affiliate: { firstName: string; lastName: string; email: string };
      };

      const columns: CsvColumn<Row>[] = [
        { header: 'Order ID', value: (r) => r.externalOrderId },
        { header: 'Campaign', value: (r) => r.campaign.name },
        {
          header: 'Affiliate',
          value: (r) => `${r.affiliate.firstName} ${r.affiliate.lastName}`,
        },
        { header: 'Affiliate email', value: (r) => r.affiliate.email },
        { header: 'Order value', value: (r) => money(r.conversionValue as never) },
        { header: 'Commission', value: (r) => money(r.commissionAmount as never) },
        { header: 'Status', value: (r) => r.status },
        { header: 'Occurred at', value: (r) => csvDate(r.occurredAt) },
        { header: 'Reported at', value: (r) => csvDate(r.createdAt) },
      ];

      const pages = paginate<Row>((skip, take) =>
        prisma.conversion.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip,
          take,
          select: {
            externalOrderId: true,
            conversionValue: true,
            commissionAmount: true,
            status: true,
            occurredAt: true,
            createdAt: true,
            campaign: { select: { name: true } },
            affiliate: {
              select: { firstName: true, lastName: true, email: true },
            },
          },
        })
      );

      return sendCsv(reply, csvFilename('conversions'), streamCsv(columns, pages));
    }
  );

  app.get(
    '/affiliate/commissions/export',
    {
      preHandler: [requireAuth, requireRole('AFFILIATE')],
      ...exportRateLimit,
    },
    async (req, reply) => {
      const user = (req as AuthedRequest).user;

      type Row = {
        amount: unknown;
        status: string;
        createdAt: Date;
        approvedAt: Date | null;
        paidAt: Date | null;
        campaign: { name: string };
        conversion: { externalOrderId: string; conversionValue: unknown };
      };

      const columns: CsvColumn<Row>[] = [
        { header: 'Order ID', value: (r) => r.conversion.externalOrderId },
        { header: 'Campaign', value: (r) => r.campaign.name },
        {
          header: 'Order value',
          value: (r) => money(r.conversion.conversionValue as never),
        },
        { header: 'Commission', value: (r) => money(r.amount as never) },
        { header: 'Status', value: (r) => r.status },
        { header: 'Earned at', value: (r) => csvDate(r.createdAt) },
        { header: 'Approved at', value: (r) => csvDate(r.approvedAt) },
        { header: 'Paid at', value: (r) => csvDate(r.paidAt) },
      ];

      const pages = paginate<Row>((skip, take) =>
        prisma.commission.findMany({
          where: { affiliateId: user.id },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            amount: true,
            status: true,
            createdAt: true,
            approvedAt: true,
            paidAt: true,
            campaign: { select: { name: true } },
            conversion: {
              select: { externalOrderId: true, conversionValue: true },
            },
          },
        })
      );

      return sendCsv(reply, csvFilename('commissions'), streamCsv(columns, pages));
    }
  );

  app.get(
    '/admin/payouts/export',
    {
      preHandler: [requireAuth, requireRole('ADMIN')],
      ...exportRateLimit,
    },
    async (_req, reply) => {
      type Row = {
        id: string;
        amount: unknown;
        feeAmount: unknown;
        netAmount: unknown;
        currency: string;
        method: string;
        status: string;
        stripeTransferId: string | null;
        createdAt: Date;
        paidAt: Date | null;
        affiliate: { email: string; firstName: string; lastName: string };
      };

      const columns: CsvColumn<Row>[] = [
        { header: 'Payout ID', value: (r) => r.id },
        {
          header: 'Affiliate',
          value: (r) => `${r.affiliate.firstName} ${r.affiliate.lastName}`,
        },
        { header: 'Email', value: (r) => r.affiliate.email },
        { header: 'Gross', value: (r) => money(r.amount as never) },
        { header: 'Fee', value: (r) => money(r.feeAmount as never) },
        { header: 'Net', value: (r) => money(r.netAmount as never) },
        { header: 'Currency', value: (r) => r.currency },
        { header: 'Method', value: (r) => r.method },
        { header: 'Status', value: (r) => r.status },
        { header: 'Reference', value: (r) => r.stripeTransferId },
        { header: 'Requested at', value: (r) => csvDate(r.createdAt) },
        { header: 'Paid at', value: (r) => csvDate(r.paidAt) },
      ];

      const pages = paginate<Row>((skip, take) =>
        prisma.payout.findMany({
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            id: true,
            amount: true,
            feeAmount: true,
            netAmount: true,
            currency: true,
            method: true,
            status: true,
            stripeTransferId: true,
            createdAt: true,
            paidAt: true,
            affiliate: {
              select: { email: true, firstName: true, lastName: true },
            },
          },
        })
      );

      return sendCsv(reply, csvFilename('payouts'), streamCsv(columns, pages));
    }
  );
}
