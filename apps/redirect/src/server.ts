import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Redis } from 'ioredis';
import crypto from 'node:crypto';
import type { CachedTrackingLink } from '@affiliate/shared';

const PORT = Number(process.env.REDIRECT_PORT ?? 3002);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const FALLBACK_URL = process.env.DEFAULT_FALLBACK_URL ?? 'https://example.com';
const IP_SALT = process.env.IP_SALT ?? 'dev-salt-change-me';

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? false : { level: 'info' },
    disableRequestLogging: process.env.NODE_ENV === 'production',
    trustProxy: true,
  });

  await app.register(cookie);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get<{ Params: { shortCode: string }; Querystring: Record<string, string> }>(
    '/r/:shortCode',
    async (request, reply) => {
    const { shortCode } = request.params;

    const cached = await redis.get(`link:${shortCode}`);
      if (!cached) return reply.redirect(FALLBACK_URL, 302);

    let link: CachedTrackingLink;
    try {
      link = JSON.parse(cached);
    } catch {
        return reply.redirect(FALLBACK_URL, 302);
    }
      if (!link.isActive) return reply.redirect(FALLBACK_URL, 302);

    let cookieId = request.cookies?.attribution_id;
    if (!cookieId) cookieId = crypto.randomUUID();

    reply.setCookie('attribution_id', cookieId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: link.cookieLifetimeDays * 86400,
      path: '/',
    });

    const subIds: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.query ?? {})) {
      if (!k.startsWith('_')) subIds[k] = String(v);
    }

    redis
      .lpush(
        'click_events',
        JSON.stringify({
          trackingLinkId: link.id,
          affiliateId: link.affiliateId,
          campaignId: link.campaignId,
          cookieId,
          timestamp: Date.now(),
          ip: hashIP(request.ip),
          userAgent: request.headers['user-agent'] ?? '',
          referrer: (request.headers.referer as string) ?? '',
          subIds,
        })
      )
      .catch(() => {});

    const dest = new URL(link.destinationUrl);
    dest.searchParams.set('_ref', cookieId);
    for (const [k, v] of Object.entries(subIds)) {
      dest.searchParams.set(k, v);
    }
      return reply.redirect(dest.toString(), 302);
    }
  );

  return app;
}

function hashIP(ip: string): string {
  return crypto
    .createHash('sha256')
    .update(ip + IP_SALT)
    .digest('hex')
    .slice(0, 16);
}

buildApp()
  .then(async (app) => {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`Redirect service on 0.0.0.0:${PORT}`);
  })
  .catch((err) => {
    const app = Fastify({ logger: true });
    app.log.error({ err }, 'Redirect service failed to start');
    process.exit(1);
  });
