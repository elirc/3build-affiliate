import type { FastifyInstance } from 'fastify';
import { analyticsService } from '../services/analytics.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function analyticsRoutes(app: FastifyInstance) {
  const svc = analyticsService();

  app.get(
    '/brand/analytics',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const days = Math.min(90, Number((req.query as any).days ?? 30));
      return svc.forBrand(user.id, days);
    }
  );

  app.get(
    '/affiliate/analytics',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const days = Math.min(90, Number((req.query as any).days ?? 30));
      return svc.forAffiliate(user.id, days);
    }
  );
}
