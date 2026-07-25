import type { FastifyInstance } from 'fastify';
import { createTrackingLinkSchema } from '@affiliate/shared';
import { trackingService } from '../services/tracking.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function trackingRoutes(app: FastifyInstance) {
  const svc = trackingService();

  app.post(
    '/affiliate/links',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req, reply) => {
      const input = createTrackingLinkSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const link = await svc.create(user.id, input);
      reply.code(201);
      return link;
    }
  );

  app.get(
    '/affiliate/links',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return svc.listMine(user.id);
    }
  );

  app.get(
    '/affiliate/eligible-campaigns',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return svc.listEligibleCampaigns(user.id);
    }
  );

  app.patch(
    '/affiliate/links/:id',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { isActive } = req.body as { isActive: boolean };
      const user = (req as AuthedRequest).user;
      return svc.toggleActive(user.id, id, isActive);
    }
  );
}
