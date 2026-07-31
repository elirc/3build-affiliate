import type { FastifyInstance, FastifyRequest } from 'fastify';
import { REQUEST_ID_HEADER, sanitiseRequestId } from '@affiliate/shared';
import {
  newRequestId,
  runWithContext,
  type RequestContext,
} from '../lib/request-context';
import {
  httpRequestDuration,
  httpRequestsTotal,
  queueDepth,
  registry,
  workerLastRun,
} from '../lib/metrics';
import { logger } from '../lib/logger';
import { readHeartbeat } from '../lib/heartbeat';
import {
  DLQ_KEY,
  PARKED_KEY,
  QUEUE_KEY,
  WORKER_NAME as CLICK_WORKER,
} from '../workers/click-event.worker';
import { WORKER_NAME as LOCK_WORKER } from '../workers/lock-expiry.worker';
import { WORKER_NAME as NOTIFICATION_WORKER } from '../workers/notification.worker';
import { WORKER_NAME as WEBHOOK_WORKER } from '../workers/webhook-delivery.worker';
import { redis } from '../config/redis';

/**
 * The label used when nothing matched.
 *
 * A 404 has no route pattern, and the obvious fallback -- `req.url` -- is the
 * one thing that must never become a label: anyone can invent paths, so a
 * scanner walking `/api/x1`, `/api/x2`, ... would mint a new time series per
 * request and take the metrics backend down. One bucket for all of them.
 */
export const UNMATCHED_ROUTE = '__unmatched__';

/**
 * The route *pattern*, e.g. `/api/brand/campaigns/:id`.
 *
 * Never `req.url`. `/api/brand/campaigns/clx123` and `/api/brand/campaigns/clx456`
 * are the same endpoint for every operational question anyone will ever ask,
 * and treating them as different series is unbounded cardinality bought for
 * nothing.
 */
export function routePattern(req: FastifyRequest): string {
  return req.routeOptions?.url ?? UNMATCHED_ROUTE;
}

/**
 * Correlation ids and RED metrics.
 *
 * Registered on the root instance before the routes, exactly like
 * `registerIdempotency` and for the same reason: hooks added inside a
 * `fastify-plugin` wrapper are encapsulated to that scope, and every route in
 * this app lives in a child scope created by `app.register(..., { prefix })`.
 * Adding them to the parent first means every child inherits them, with no
 * extra dependency.
 */
export function registerObservability(app: FastifyInstance) {
  // Keyed by the request object rather than decorated onto it: nothing outside
  // this file needs the start time, and a WeakMap keeps it from outliving the
  // request. `registerIdempotency` tracks its claims the same way.
  const startedAt = new WeakMap<FastifyRequest, bigint>();

  // Not `async`: this hook has to call `done()` from *inside* the
  // AsyncLocalStorage frame so that the rest of the lifecycle inherits it. An
  // async hook returns before the handler runs and the store would be gone.
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
    startedAt.set(req, process.hrtime.bigint());

    // Echoed even on an error path, because the id is only useful to whoever
    // is about to quote it in a support ticket.
    reply.header(REQUEST_ID_HEADER, context.requestId);

    runWithContext(context, done);
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = startedAt.get(req);
    const route = routePattern(req);
    const seconds = started === undefined ? 0 : Number(process.hrtime.bigint() - started) / 1e9;

    httpRequestsTotal.inc({
      method: req.method,
      route,
      status: String(reply.statusCode),
    });
    httpRequestDuration.observe({ method: req.method, route }, seconds);
  });

  registerCollectors();
}

/**
 * Gauges read at scrape time.
 *
 * Idempotent: `Registry.collect` is keyed by name, and `build()` is called once
 * per test file in a single process.
 */
function registerCollectors() {
  registry.collect('queues', async () => {
    const [pending, dead, parked] = await Promise.all([
      redis.llen(QUEUE_KEY),
      redis.llen(DLQ_KEY),
      redis.llen(PARKED_KEY),
    ]);
    queueDepth.set({ queue: QUEUE_KEY }, pending);
    queueDepth.set({ queue: DLQ_KEY }, dead);
    queueDepth.set({ queue: PARKED_KEY }, parked);
  });

  registry.collect('workers', async () => {
    const workers = [CLICK_WORKER, LOCK_WORKER, NOTIFICATION_WORKER, WEBHOOK_WORKER];
    const beats = await Promise.all(workers.map((w) => readHeartbeat(w)));
    workers.forEach((worker, i) => {
      // Zero rather than omitting the series. `time() - worker_last_run_timestamp
      // > 60` is the alert anyone will actually write, and it fires correctly
      // on zero; an absent series makes that same expression evaluate to
      // nothing, which alerts on neither a stopped worker nor a healthy one.
      workerLastRun.set({ worker }, beats[i] ? Math.floor(beats[i]!.at / 1000) : 0);
    });
  });
}
