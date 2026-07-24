import type { FastifyInstance } from 'fastify';
import { applyToCampaignSchema } from '@affiliate/shared';
import { z } from 'zod';
import { relationshipService } from '../services/relationship.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject', 'deactivate']),
});

export async function relationshipRoutes(app: FastifyInstance) {
  const svc = relationshipService();

  app.post(
    '/affiliate/applications',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req, reply) => {
      const input = applyToCampaignSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const rel = await svc.apply(user.id, input);
      reply.code(201);
      return rel;
    }
  );

  app.get(
    '/affiliate/applications',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return svc.listForAffiliate(user.id);
    }
  );

  app.get(
    '/brand/affiliates',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { status } = req.query as { status?: string };
      return svc.listForBrand(user.id, status);
    }
  );

  app.post(
    '/brand/affiliates/:id/review',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { action } = reviewSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.review(user.id, id, action);
    }
  );
}
