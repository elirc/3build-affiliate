import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { createApiFetchLink, createLinkResolver } from './link-resolver';

const PORT = Number(process.env.REDIRECT_PORT ?? 3002);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const FALLBACK_URL = process.env.DEFAULT_FALLBACK_URL ?? 'https://example.com';
const IP_SALT = process.env.IP_SALT ?? 'dev-salt-change-me';
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';

/**
 * A shopper is waiting on this request. If the API cannot answer within this
 * budget we send them to the fallback rather than holding the connection open
 * while our infrastructure recovers.
 */
const LOOKUP_TIMEOUT_MS = Number(process.env.LINK_LOOKUP_TIMEOUT_MS ?? 150);

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? false : { level: 'info' },
    disableRequestLogging: process.env.NODE_ENV === 'production',
    trustProxy: true,
  });

  await app.register(cookie);

  const resolveLink = createLinkResolver({
    redis,
    fetchLink: createApiFetchLink({
      baseUrl: API_INTERNAL_URL,
      token: INTERNAL_API_TOKEN,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    }),
    onError: (err, shortCode) =>
      app.log.warn({ err, shortCode }, 'Link resolution degraded'),
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get<{ Params: { shortCode: string }; Querystring: Record<string, string> }>(
    '/r/:shortCode',
    async (request, reply) => {
      const { shortCode } = request.params;

      const link = await resolveLink(shortCode);
      if (!link) return reply.redirect(FALLBACK_URL, 302);
      if (!link.isActive) return reply.redirect(FALLBACK_URL, 302);

      // An ended campaign still gets the shopper to the brand rather than to
      // a generic placeholder -- the click is already paid for, so wasting it
      // helps nobody. No click event is recorded: the campaign is over and
      // this traffic can never convert.
      //
      // `undefined` means the entry was cached before this field existed;
      // treat that as "keep serving", which is the previous behaviour.
      if (link.campaignStatus === 'ENDED') {
        return reply.redirect(link.campaignLandingPageUrl ?? FALLBACK_URL, 302);
      }

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

      // Fire and forget on purpose: losing a click is better than making a
      // shopper wait on our queue.
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
    if (!INTERNAL_API_TOKEN) {
      app.log.warn(
        'INTERNAL_API_TOKEN is not set; cache misses cannot be resolved and ' +
          'will fall back to DEFAULT_FALLBACK_URL'
      );
    }
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`Redirect service on 0.0.0.0:${PORT}`);
  })
  .catch((err) => {
    const app = Fastify({ logger: true });
    app.log.error({ err }, 'Redirect service failed to start');
    process.exit(1);
  });
