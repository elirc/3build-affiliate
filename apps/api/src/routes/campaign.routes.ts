import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createApiKeySchema,
  createCampaignSchema,
  listCampaignsQuerySchema,
  transitionCampaignSchema,
  updateCampaignSchema,
} from '@affiliate/shared';
import { campaignService } from '../services/campaign.service';
import { apiKeyService } from '../services/api-key.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const publicProgramsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export async function campaignRoutes(app: FastifyInstance) {
  const svc = campaignService();
  const apiKeys = apiKeyService();

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

  app.post(
    '/brand/campaigns/:id/transition',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { to } = transitionCampaignSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.transition(user.id, id, to);
    }
  );

  // ---- Postback credentials -------------------------------------------
  // Keys live under their campaign because that is what they authorise.

  app.get(
    '/brand/campaigns/:id/api-keys',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return apiKeys.list(user.id, id);
    }
  );

  app.post(
    '/brand/campaigns/:id/api-keys',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { label } = createApiKeySchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const created = await apiKeys.create(user.id, id, label);
      reply.code(201);
      // The only response that ever contains `secret`. Callers must store it
      // now; there is no endpoint that will show it again.
      return created;
    }
  );

  app.delete(
    '/brand/campaigns/:id/api-keys/:keyId',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id, keyId } = req.params as { id: string; keyId: string };
      const user = (req as AuthedRequest).user;
      return apiKeys.revoke(user.id, id, keyId);
    }
  );

  app.get('/public/programs', async (req) => {
    // Unauthenticated and therefore the easiest endpoint in the system to
    // abuse. Number('abc') is NaN, and an unbounded pageSize is a free way to
    // ask for every campaign in the database.
    const { page, pageSize } = publicProgramsQuerySchema.parse(req.query);
    return svc.listOpenPrograms(page, pageSize);
  });
}
