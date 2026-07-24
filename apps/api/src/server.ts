import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env';
import { logger } from './lib/logger';
import { registerErrorHandler } from './lib/error-handler';
import { authRoutes } from './routes/auth.routes';
import { campaignRoutes } from './routes/campaign.routes';
import { trackingRoutes } from './routes/tracking.routes';
import { conversionRoutes } from './routes/conversion.routes';
import { payoutRoutes } from './routes/payout.routes';
import { relationshipRoutes } from './routes/relationship.routes';
import { analyticsRoutes } from './routes/analytics.routes';
import { adminRoutes } from './routes/admin.routes';
import { startClickEventWorker } from './workers/click-event.worker';
import { startLockExpiryWorker } from './workers/lock-expiry.worker';

async function build() {
  const app = Fastify({ logger: false });

  await app.register(helmet);
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? env.WEB_ORIGIN : true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });

  registerErrorHandler(app);

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(campaignRoutes, { prefix: '/api' });
  await app.register(trackingRoutes, { prefix: '/api' });
  await app.register(conversionRoutes, { prefix: '/api' });
  await app.register(payoutRoutes, { prefix: '/api' });
  await app.register(relationshipRoutes, { prefix: '/api' });
  await app.register(analyticsRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });

  return app;
}

async function main() {
  const app = await build();
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info(`API listening on ${env.API_HOST}:${env.API_PORT}`);
  if (!env.DISABLE_WORKERS) {
    startClickEventWorker();
    startLockExpiryWorker();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
