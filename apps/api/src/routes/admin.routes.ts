import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';
import { Errors } from '../lib/errors';

const decisionSchema = z.object({
  decision: z.enum(['CLEARED', 'FLAGGED', 'BLOCKED']),
  notes: z.string().max(1000).optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  app.get(
    '/admin/fraud-reviews',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const q = req.query as { decision?: string };
      return prisma.fraudReview.findMany({
        where: q.decision ? { decision: q.decision as any } : { decision: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          conversion: {
            select: {
              id: true,
              externalOrderId: true,
              conversionValue: true,
              commissionAmount: true,
              affiliateId: true,
              campaignId: true,
              status: true,
            },
          },
        },
      });
    }
  );

  app.post(
    '/admin/fraud-reviews/:id/decide',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const input = decisionSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const existing = await prisma.fraudReview.findUnique({ where: { id } });
      if (!existing) throw Errors.notFound('Fraud review');

      const result = await prisma.fraudReview.update({
        where: { id },
        data: {
          decision: input.decision,
          notes: input.notes,
          reviewerId: user.id,
          decidedAt: new Date(),
        },
      });

      // BLOCKED → reject the conversion and reverse any LOCKED commissions
      if (input.decision === 'BLOCKED') {
        await prisma.$transaction([
          prisma.conversion.update({
            where: { id: existing.conversionId },
            data: {
              status: 'REJECTED',
              rejectedAt: new Date(),
              rejectionReason: 'Blocked by fraud review',
            },
          }),
          prisma.commission.updateMany({
            where: { conversionId: existing.conversionId, status: 'LOCKED' },
            data: { status: 'CLAWED_BACK' },
          }),
        ]);
      }
      return result;
    }
  );
}
