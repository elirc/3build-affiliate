import type { FastifyInstance } from 'fastify';
import {
  recurringBillingSchema,
  reportConversionSchema,
  reverseConversionSchema,
  reviewConversionSchema,
} from '@affiliate/shared';
import { conversionService } from '../services/conversion.service';
import { subscriptionService } from '../services/subscription.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';
import { requirePostbackSignature, type RawBodyRequest } from '../lib/postback-auth';
import { z } from 'zod';

const brandConversionsQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  /**
   * Offset paging. Deprecated, and kept working for one release.
   *
   * Breaking the web client in the same change that adds the replacement
   * would make a correctness fix look like an outage. `cursor` takes
   * precedence when both are sent.
   */
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(500).optional(),
});

export async function conversionRoutes(app: FastifyInstance) {
  const svc = conversionService();
  const subscriptions = subscriptionService();

  /**
   * Server-to-server endpoint called by the brand's storefront.
   *
   * Registered in its own encapsulated plugin scope so the raw-body parser and
   * the relaxed rate limit apply here and nowhere else. Fastify scopes content
   * type parsers to the plugin that registers them, which is what makes this
   * safe without changing how the rest of the API parses JSON.
   */
  await app.register(async (scope) => {
    // The HMAC covers the bytes exactly as sent. Fastify's default parser
    // hands us an object, and re-serialising it would reorder keys and drop
    // whitespace, so the signature could never match. Keep the string, then
    // parse it ourselves.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as RawBodyRequest).rawBody = body as string;
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    scope.post<{ Params: { campaignId: string } }>(
      '/conversions/:campaignId',
      {
        preHandler: [requirePostbackSignature()],
        config: {
          // Keyed per credential rather than per IP: one brand's spike must
          // not throttle another's, and storefronts commonly share egress IPs
          // behind a NAT or a serverless platform.
          rateLimit: { tier: 'postback' },
          // The endpoint that most needs this: a brand's storefront retries on
          // timeout, and it cannot tell a request that was applied from one
          // that was not. `(campaignId, externalOrderId)` is unique, so a
          // duplicate could never create a second conversion -- but it would
          // return a 409 that looks like a failure, and the storefront would
          // keep retrying something that had in fact succeeded.
          idempotent: true,
        },
      },
      async (req, reply) => {
        const { campaignId } = req.params;
        const input = reportConversionSchema.parse(req.body);
        const result = await svc.report(campaignId, input);
        reply.code(201);
        return result;
      }
    );

    // Renewals are signed exactly like first sales -- they create commissions,
    // so they need the same authentication and the same per-key budget. Left
    // on the default IP tier they would have shared one bucket with every
    // other brand's renewals.
    scope.post<{ Params: { campaignId: string } }>(
      '/conversions/:campaignId/recurring',
      {
        preHandler: [requirePostbackSignature()],
        config: { rateLimit: { tier: 'postback' } },
      },
      async (req) => {
        const input = recurringBillingSchema.parse(req.body);
        return subscriptions.recordBillingPeriod(req.params.campaignId, input);
      }
    );

    scope.post<{ Params: { campaignId: string } }>(
      '/conversions/:campaignId/recurring/cancel',
      {
        preHandler: [requirePostbackSignature()],
        config: { rateLimit: { tier: 'postback' } },
      },
      async (req) => {
        const { externalReference } = recurringBillingSchema
          .pick({ externalReference: true })
          .parse(req.body);
        return subscriptions.cancel(req.params.campaignId, externalReference);
      }
    );
  });

  app.get(
    '/brand/conversions',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      // status was passed straight through to the repository and cast to a
      // Prisma enum, so an unknown value became a 500 rather than a 400.
      const q = brandConversionsQuerySchema.parse(req.query);

      // Cursor wins when both are present: a client that has moved over should
      // not silently fall back to the paging mode this replaces.
      if (q.cursor || req.headers['x-pagination'] === 'cursor') {
        return svc.seekForBrand(user.id, {
          status: q.status,
          pageSize: q.pageSize,
          cursor: q.cursor,
        });
      }

      return svc.listForBrand(user.id, q);
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

  // Separate from review: reversing an *approved* conversion is a different
  // operation with different consequences, and merging the two would mean one
  // handler where the commission may or may not already have been paid.
  app.post(
    '/brand/conversions/:id/reverse',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const input = reverseConversionSchema.parse(req.body);
      const user = (req as AuthedRequest).user;
      return svc.reverse(user.id, id, input);
    }
  );
}
