import type { FastifyInstance, FastifyRequest } from 'fastify';
import { REQUEST_ID_HEADER, sanitiseRequestId } from '@affiliate/shared';
import { newRequestId, runWithContext, type RequestContext } from '../lib/request-context';
import { logger } from '../lib/logger';

/**
 * The label used when nothing matched.
 *
 * A 404 has no route pattern, and the obvious fallback -- `req.url` -- is the
 * one thing that must never become a label: anyone can invent paths, so a
 * scanner walking `/api/x1`, `/api/x2`, ... would mint a new time series per
 * request. One bucket for all of them.
 */
export const UNMATCHED_ROUTE = '__unmatched__';

/**
 * The route *pattern*, e.g. `/api/brand/campaigns/:id`.
 *
 * Never `req.url`. `/api/brand/campaigns/clx123` and `/api/brand/campaigns/clx456`
 * are the same endpoint for every operational question anyone will ever ask,
 * and treating them as different is unbounded cardinality bought for nothing.
 */
export function routePattern(req: FastifyRequest): string {
  return req.routeOptions?.url ?? UNMATCHED_ROUTE;
}

/**
 * Correlation ids.
 *
 * Registered on the root instance before the routes, exactly like
 * `registerIdempotency` and for the same reason: hooks added inside a
 * `fastify-plugin` wrapper are encapsulated to that scope, and every route in
 * this app lives in a child scope created by `app.register(..., { prefix })`.
 * Adding them to the parent first means every child inherits them, with no
 * extra dependency.
 */
export function registerObservability(app: FastifyInstance) {
  // Not `async`: this hook has to call `done()` from *inside* the
  // AsyncLocalStorage frame so that the rest of the lifecycle inherits it. An
  // async hook returns before the handler runs, and the store would be gone.
  app.addHook('onRequest', (req, reply, done) => {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const accepted = sanitiseRequestId(inbound);

    if (inbound !== undefined && accepted === null) {
      // The length, and nothing else. Writing the value here to explain why we
      // refused it would be the log injection we just prevented.
      logger.warn(
        { length: typeof inbound === 'string' ? inbound.length : 0, route: routePattern(req) },
        'Ignored an untrusted X-Request-Id and generated one instead'
      );
    }

    const context: RequestContext = {
      requestId: accepted ?? newRequestId(),
      route: routePattern(req),
    };

    // Echoed even on an error path, because the id is only useful to whoever
    // is about to quote it in a support ticket.
    reply.header(REQUEST_ID_HEADER, context.requestId);

    runWithContext(context, done);
  });
}
