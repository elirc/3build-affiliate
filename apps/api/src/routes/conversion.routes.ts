import type { FastifyInstance } from 'fastify';
import { reportConversionSchema, reviewConversionSchema } from '@affiliate/shared';
import { conversionService } from '../services/conversion.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function conversionRoutes(app: FastifyInstance) {
  const svc = conversionService();

  // Server-to-server endpoint called by the brand's storefront
  app.post('/conversions/:campaignId', async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    const input = reportConversionSchema.parse(req.body);
    const result = await svc.report(campaignId, input);
    reply.code(201);
    return result;
  });

  app.get(
    '/brand/conversions',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const q = req.query as any;
      return svc.listForBrand(user.id, {
        status: q.status,
        page: Number(q.page ?? 1),
        pageSize: Number(q.pageSize ?? 20),
      });
    }
  );

  app.post(
    '/brand/conversions/:id/review',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const input = reviewConversionSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.review(user.id, id, input);
    }
  );
}
