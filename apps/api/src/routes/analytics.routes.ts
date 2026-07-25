import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analyticsService } from '../services/analytics.service';
import { breakdownService, subIdService } from '../services/breakdown.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';
import { rangeFromDays, resolveRange } from '@affiliate/analytics';
import { Errors } from '../lib/errors';

const seriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/**
 * `days` is kept alongside `from`/`to` rather than replaced: existing links
 * and bookmarks use it, and a shorthand for "the last 30 days" is genuinely
 * more convenient than spelling out two timestamps.
 */
const rangeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  compare: z.enum(['true', 'false']).default('false'),
});

const RANGE_ERRORS: Record<string, string> = {
  end_before_start: 'The end of the range is before its start',
  range_too_long: 'Ranges are limited to 365 days',
  start_in_future: 'The start of the range is in the future',
};

function parseRange(query: unknown) {
  const q = rangeQuerySchema.parse(query);

  // `days` wins when both are given, because it is the simpler intent and
  // mixing the two is more likely a bug than a request.
  if (q.days !== undefined) {
    return { window: rangeFromDays(q.days), compare: q.compare === 'true' };
  }

  const resolved = resolveRange(
    q.from ? new Date(q.from) : undefined,
    q.to ? new Date(q.to) : undefined
  );
  if (!resolved.ok) {
    throw Errors.invalidRequest('INVALID_RANGE', RANGE_ERRORS[resolved.reason]!);
  }

  return { window: resolved.range, compare: q.compare === 'true' };
}

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

const subIdQuerySchema = z.object({
  /**
   * The JSON key to group by. Bound as a parameter to `->>`, not
   * interpolated -- unlike a column name, a JSON key *can* be a bind
   * parameter, so there is no reason to whitelist it.
   */
  key: z.string().min(1).max(40),
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export async function analyticsRoutes(app: FastifyInstance) {
  const svc = analyticsService();
  const breakdown = breakdownService();
  const subIds = subIdService();

  const parseBreakdown = (query: unknown) => {
    const q = breakdownQuerySchema.parse(query);
    return { ...q, includePending: q.includePending === 'true' };
  };

  app.get(
    '/brand/analytics',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { window, compare } = parseRange(req.query);
      return svc.forBrand(user.id, window, compare);
    }
  );

  app.get(
    '/affiliate/analytics',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { window, compare } = parseRange(req.query);
      return svc.forAffiliate(user.id, window, compare);
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

  // ---- Sub-IDs ----------------------------------------------------------
  // The tags an affiliate puts on their own links, so they can tell one
  // placement from another. Captured since the first commit and, until now,
  // read by nothing.

  app.get(
    '/affiliate/analytics/subids/keys',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { days } = seriesQuerySchema.parse(req.query);
      return subIds.keys(user.id, days);
    }
  );

  app.get(
    '/affiliate/analytics/subids',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const { key, days } = subIdQuerySchema.parse(req.query);
      return subIds.report(user.id, key, days);
    }
  );
}
