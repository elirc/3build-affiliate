import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analyticsService } from '../services/analytics.service';
import { breakdownService } from '../services/breakdown.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

const seriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const breakdownQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  /**
   * Validated by lookup, not by pattern. The value never reaches SQL -- it
   * selects a column expression we wrote. See packages/analytics/src/sort.ts.
   */
  sort: z.string().max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  /** Query strings are strings; an enum is honest about that. */
  includePending: z.enum(['true', 'false']).default('false'),
});

export async function analyticsRoutes(app: FastifyInstance) {
  const svc = analyticsService();
  const breakdown = breakdownService();

  const parseBreakdown = (query: unknown) => {
    const q = breakdownQuerySchema.parse(query);
    return { ...q, includePending: q.includePending === 'true' };
  };

  app.get(
    '/brand/analytics',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { days } = seriesQuerySchema.parse(req.query);
      return svc.forBrand(user.id, days);
    }
  );

  app.get(
    '/affiliate/analytics',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { days } = seriesQuerySchema.parse(req.query);
      return svc.forAffiliate(user.id, days);
    }
  );

  // ---- Breakdowns -------------------------------------------------------
  // The series answers "how are we doing?". These answer "which of these is
  // doing it", which is the question that changes a decision.

  app.get(
    '/brand/analytics/campaigns',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return breakdown.byCampaign(user.id, parseBreakdown(req.query));
    }
  );

  app.get(
    '/brand/analytics/affiliates',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return breakdown.byAffiliate(user.id, parseBreakdown(req.query));
    }
  );

  app.get(
    '/affiliate/analytics/campaigns',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return breakdown.forAffiliateOwnCampaigns(user.id, parseBreakdown(req.query));
    }
  );

  app.get(
    '/affiliate/analytics/links',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      return breakdown.forAffiliateLinks(user.id, parseBreakdown(req.query));
    }
  );
}
