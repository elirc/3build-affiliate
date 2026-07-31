import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { newDbTiming, runWithDbTiming, type DbTiming } from '../lib/db-timing';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated for every request. Read in `onResponse`, and by tests that
     * need to assert how much database work an endpoint did.
     */
    dbTiming?: DbTiming;
  }
}

/**
 * Logs any request that spent more than its budget waiting on Postgres.
 *
 * The point is not the number, it is the attribution. A `warn` carrying the
 * route, the total database time, how many queries produced it and which one
 * was worst turns "the dashboard is slow" into a line you can grep for and a
 * query you can go and `EXPLAIN`. Without it the only evidence is a user's
 * impression, and the only response is to guess.
 *
 * Deliberately measures *database* time rather than total request time: those
 * are different diagnoses. A slow handler doing 3ms of SQL is a code problem;
 * 900ms of SQL behind a 20ms handler is this one.
 */
export function registerDbTiming(app: FastifyInstance) {
  // Registered on the root instance before the routes, so the child scopes
  // `app.register(..., { prefix })` creates inherit it. The same reasoning as
  // registerIdempotency, and for the same reason: `fastify-plugin` would
  // encapsulate the hook to a scope the routes are not in.
  app.addHook('onRequest', (req, _reply, done) => {
    const timing = newDbTiming();
    req.dbTiming = timing;
    // Callback form on purpose: `runWithDbTiming(timing, done)` is what puts
    // the rest of the request inside the async context. An `async` hook would
    // establish a context that ends when the hook returns, which is before the
    // handler runs and therefore before any query happens.
    runWithDbTiming(timing, done);
  });

  app.addHook('onResponse', async (req, reply) => {
    const timing = req.dbTiming;
    if (!timing || timing.totalMs <= env.SLOW_REQUEST_DB_MS) return;

    logger.warn(
      {
        method: req.method,
        statusCode: reply.statusCode,
        dbMs: Math.round(timing.totalMs),
        queries: timing.queries,
        slowestQuery: timing.slowest,
        totalMs: Math.round(reply.elapsedTime),
        // No `correlationId` and no `route` here any more: the logger's
        // context mixin adds `requestId` and the route *pattern* to every
        // record. The id it adds is the one propagated across services, unlike
        // Fastify's `req.id`, which is a per-process counter that means nothing
        // to the redirect service or to the click worker. Two ids on one line
        // is worse than one, because it invites grepping the one that does not
        // join up.
      },
      'Request exceeded its database time budget'
    );
  });
}
