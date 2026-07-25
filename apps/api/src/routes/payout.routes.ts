import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestPayoutSchema } from '@affiliate/shared';
import { payoutService } from '../services/payout.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const failSchema = z.object({
  reason: z.string().min(1).max(500),
});

const completeSchema = z.object({
  /** Bank reference or Stripe transfer id, so a payment can be traced later. */
  reference: z.string().max(200).optional(),
});

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

  app.get(
    '/affiliate/payouts',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { page, pageSize } = paginationSchema.parse(req.query);
      return svc.listForAffiliate(user.id, { page, pageSize });
    }
  );

  app.post(
    '/affiliate/payouts',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req, reply) => {
      const input = requestPayoutSchema.parse(req.body);
      const user = (req as AuthedRequest).user;

      // Standard header name, so an HTTP client with built-in retry support
      // sets it without needing to know anything about this API.
      const rawKey = req.headers['idempotency-key'];
      const idempotencyKey = typeof rawKey === 'string' ? rawKey.slice(0, 200) : undefined;

      const p = await svc.requestPayout(user.id, input.method, { idempotencyKey });
      reply.code(201);
      return p;
    }
  );

  // ---- Admin queue -----------------------------------------------------
  // Payouts move money out of the platform, so every transition is an
  // explicit admin action rather than anything automatic.

  app.get(
    '/admin/payouts',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { page, pageSize } = paginationSchema.parse(req.query);
      const { status } = req.query as { status?: string };
      return svc.listForAdmin({ status, page, pageSize });
    }
  );

  app.get(
    '/admin/payouts/:id/history',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      return svc.history(id);
    }
  );

  app.post(
    '/admin/payouts/:id/process',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return svc.transition(id, 'PROCESSING', { actorId: user.id });
    }
  );

  app.post(
    '/admin/payouts/:id/complete',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { reference } = completeSchema.parse(req.body ?? {});
      const user = (req as AuthedRequest).user;
      return svc.transition(id, 'PAID', { actorId: user.id, reference });
    }
  );

  app.post(
    '/admin/payouts/:id/fail',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const { reason } = failSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.transition(id, 'FAILED', { actorId: user.id, reason });
    }
  );

  app.post(
    '/admin/payouts/:id/cancel',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return svc.transition(id, 'CANCELLED', { actorId: user.id });
    }
  );
}
