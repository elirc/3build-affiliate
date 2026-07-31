import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { env } from './config/env';
import { logger } from './lib/logger';
import { registerErrorHandler } from './lib/error-handler';
import { registerIdempotency } from './plugins/idempotency';
import { registerRateLimit } from './plugins/rate-limit';
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
import { startClickEventWorker } from './workers/click-event.worker';
import { startLockExpiryWorker } from './workers/lock-expiry.worker';
import { startNotificationWorker } from './workers/notification.worker';

export interface BuildOptions {
  /**
   * Tests drive the app through `app.inject()`, which replays requests through
   * the real router without binding a socket. The rate limiter counts those the
   * same as real traffic -- and every injected request arrives from 127.0.0.1,
   * so a suite of a few hundred shares one bucket and starts getting 429s
   * partway through, failing in a way that looks like a bug in whatever it
   * happened to be testing.
   *
   * `false` skips registering the hook at all rather than raising the limits,
   * because a limit high enough for every suite is no limit at all and would
   * quietly stop testing the thing the suite is about.
   */
  rateLimit?: boolean;
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
  // The limiter is an `onRequest` hook and idempotency a `preHandler`, so a
  // throttled request is rejected before a key is ever claimed for it --
  // otherwise the client's honest retry would replay the 429 back at itself
  // for a day.
  if (options.rateLimit !== false) registerRateLimit(app);
  registerIdempotency(app);

  app.get(
    '/health',
    // Not rate limited. A load balancer polls this every second or two from a
    // single address, and throttling the probe would take the instance out of
    // rotation for being healthy.
    { config: { rateLimit: false } },
    async () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
    })
  );

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
