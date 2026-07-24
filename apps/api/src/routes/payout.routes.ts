import type { FastifyInstance } from 'fastify';
import { requestPayoutSchema } from '@affiliate/shared';
import { payoutService } from '../services/payout.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function payoutRoutes(app: FastifyInstance) {
  const svc = payoutService();

  app.get(
    '/affiliate/earnings/summary',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return svc.summary(user.id);
    }
  );

  app.post(
    '/affiliate/payouts',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req, reply) => {
      const input = requestPayoutSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      const p = await svc.requestPayout(user.id, input.method);
      reply.code(201);
      return p;
    }
  );
}
