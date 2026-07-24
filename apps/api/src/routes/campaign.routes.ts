import type { FastifyInstance } from 'fastify';
import {
  createCampaignSchema,
  listCampaignsQuerySchema,
  updateCampaignSchema,
} from '@affiliate/shared';
import { campaignService } from '../services/campaign.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function campaignRoutes(app: FastifyInstance) {
  const svc = campaignService();

  app.get(
    '/brand/campaigns',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const query = listCampaignsQuerySchema.parse(req.query);
      const user = (req as AuthedRequest).user;
      return svc.listForBrand(user.id, query);
    }
  );

  app.post(
    '/brand/campaigns',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req, reply) => {
      const input = createCampaignSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const c = await svc.create(user.id, input);
      reply.code(201);
      return c;
    }
  );

  app.get(
    '/brand/campaigns/:id',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return svc.getById(user.id, id);
    }
  );

  app.patch(
    '/brand/campaigns/:id',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const input = updateCampaignSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.update(user.id, id, input);
    }
  );

  app.get('/public/programs', async (req) => {
    const { page = 1, pageSize = 20 } = (req.query as any) ?? {};
    return svc.listOpenPrograms(Number(page), Number(pageSize));
  });
}
