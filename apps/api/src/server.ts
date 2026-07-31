import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { env } from './config/env';
import { logger } from './lib/logger';
import { registerErrorHandler } from './lib/error-handler';
import { registerIdempotency } from './plugins/idempotency';
import { registerObservability } from './plugins/observability';
import { registerRateLimit, type RateLimitOptions } from './plugins/rate-limit';
import { registerDbTiming } from './plugins/db-timing';
import { systemService } from './services/system.service';
import { authRoutes } from './routes/auth.routes';
import { campaignRoutes } from './routes/campaign.routes';
import { trackingRoutes } from './routes/tracking.routes';
import { conversionRoutes } from './routes/conversion.routes';
import { payoutRoutes } from './routes/payout.routes';
import { relationshipRoutes } from './routes/relationship.routes';
import { analyticsRoutes } from './routes/analytics.routes';
import { adminRoutes } from './routes/admin.routes';
import { internalRoutes } from './routes/internal.routes';
import { creativeRoutes } from './routes/creative.routes';
import { profileRoutes } from './routes/profile.routes';
import { exportRoutes } from './routes/export.routes';
import { notificationRoutes } from './routes/notification.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { importRoutes } from './routes/import.routes';
import { startClickEventWorker } from './workers/click-event.worker';
import { startLockExpiryWorker } from './workers/lock-expiry.worker';
import { startNotificationWorker } from './workers/notification.worker';
import { startWebhookDeliveryWorker } from './workers/webhook-delivery.worker';
import { startImportWorker } from './workers/import.worker';

export interface BuildOptions {
  /**
   * `false` turns rate limiting off entirely.
   *
   * Tests drive the app through `app.inject()`, which replays requests through
   * the real router without binding a socket. The limiter counts those the
   * same as real traffic, so a suite of a few hundred requests starts getting
   * 429s partway through and fails in a way that looks like a bug in whatever
   * it happened to be testing.
   *
   * An object keeps the limiter on but swaps the Redis behind it, which is how
   * the "Redis is down" behaviour gets tested without taking the container
   * away from every other suite.
   */
  rateLimit?: boolean | RateLimitOptions;
}

/**
 * Builds the Fastify app without starting it.
 *
 * Exported so tests can `app.inject()` instead of binding a port: no port
 * collisions between parallel suites, no waiting for a socket, and the whole
 * middleware stack still runs.
 */
export async function build(options: BuildOptions = {}) {
  const app = Fastify({ logger: false });

  await app.register(helmet);
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? env.WEB_ORIGIN : true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, { secret: env.JWT_SECRET });

  registerErrorHandler(app);
  // Before the routes: hooks on the parent are inherited by the child scopes
  // that `app.register(..., { prefix })` creates below.
  //
  // Observability first, ahead of even the rate limiter. Binding a request id
  // costs a regex and a UUID, and it is what makes a rejection *visible*: a
  // 429 or a 409 that appears in no metric and carries no id is exactly the
  // failure that gets argued about instead of measured.
  registerObservability(app);

  // Then rate limiting, so a request that is going to be rejected is rejected
  // before anything else spends work on it. It reads the JWT, so it has to
  // come after `@fastify/jwt` is registered.
  if (options.rateLimit !== false) {
    registerRateLimit(app, typeof options.rateLimit === 'object' ? options.rateLimit : {});
  }
  registerIdempotency(app);
  // Its hook is `onRequest`, which Fastify runs before every `preHandler`, so
  // the timing context covers the idempotency plugin's own reads too -- they
  // are part of what a request costs.
  registerDbTiming(app);

  /**
   * Liveness. Deliberately trivial: it answers "should this process be
   * restarted?", and the answer must not depend on Postgres. A liveness probe
   * that checks dependencies turns a database blip into a rolling restart of
   * every instance, which is how a small outage becomes a large one.
   *
   * Never rate limited, like the readiness probe below. Probes come from a
   * handful of load balancer addresses, so they share a bucket with each other
   * and with anyone else behind the same hop; throttling one would fail a
   * liveness check and take the instance out of rotation for a reason that has
   * nothing to do with its health.
   */
  app.get('/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  /**
   * Readiness. Answers "should this instance be sent traffic?", which needs
   * the dependencies a request actually uses. 503 rather than 200-with-a-body,
   * because a load balancer reads the status code and nothing else.
   */
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const readiness = await systemService().readiness();
    if (readiness.status !== 'ok') reply.code(503);
    return readiness;
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(campaignRoutes, { prefix: '/api' });
  await app.register(trackingRoutes, { prefix: '/api' });
  await app.register(conversionRoutes, { prefix: '/api' });
  await app.register(payoutRoutes, { prefix: '/api' });
  await app.register(relationshipRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(creativeRoutes, { prefix: '/api' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(exportRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(webhookRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api' });

  // No /api prefix: these are service-to-service, and keeping them on a
  // distinct path lets a proxy refuse them from the public internet.
  await app.register(internalRoutes);

  return app;
}

async function main() {
  const app = await build();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(`API listening on ${env.API_HOST}:${env.API_PORT}`);
  if (!env.DISABLE_WORKERS) {
    startClickEventWorker();
    startLockExpiryWorker();
    startNotificationWorker();
    startWebhookDeliveryWorker();
    startImportWorker();
  }
}

// Only start a server when run directly. Importing this module for `build()`
// -- which is what the test harness does -- must not bind a port.
if (process.env.VITEST === undefined) {
  main().catch((err) => {
    logger.error({ err }, 'Fatal startup error');
    process.exit(1);
  });
}
