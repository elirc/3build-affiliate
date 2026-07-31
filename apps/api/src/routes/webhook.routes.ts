import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createWebhookEndpointSchema,
  listDeliveriesQuerySchema,
} from '@affiliate/shared';
import { webhookService } from '../services/webhook.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const idParamSchema = z.object({ id: z.string().min(1) });

export async function webhookRoutes(app: FastifyInstance) {
  const svc = webhookService();

  app.get(
    '/brand/webhooks',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return svc.listEndpoints(user.id);
    }
  );

  app.post(
    '/brand/webhooks',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req, reply) => {
      const user = (req as AuthedRequest).user;
      const input = createWebhookEndpointSchema.parse(req.body);
      const created = await svc.createEndpoint(user.id, input);
      // 201 with the secret in the body. The only time it is ever returned.
      return reply.status(201).send(created);
    }
  );

  app.delete(
    '/brand/webhooks/:id',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { id } = idParamSchema.parse(req.params);
      return svc.deleteEndpoint(user.id, id);
    }
  );

  app.get(
    '/brand/webhooks/:id/deliveries',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { id } = idParamSchema.parse(req.params);
      const query = listDeliveriesQuerySchema.parse(req.query);
      return svc.listDeliveries(user.id, id, query);
    }
  );

  app.post(
    '/brand/webhook-deliveries/:id/replay',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { id } = idParamSchema.parse(req.params);
      return svc.replayDelivery(user.id, id);
    }
  );
}
