import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REQUEST_ID_HEADER } from '@affiliate/shared';
import { build } from '../src/server';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { getRequestId } from '../src/lib/request-context';
import { QUEUE_KEY, drainClickEvents } from '../src/workers/click-event.worker';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * Correlation ids and RED metrics, end to end.
 *
 * The two things worth being careful about here are both security-shaped
 * rather than feature-shaped: an echoed header is attacker-controlled input,
 * and a metric label is an unbounded allocation. Both have a test that fails
 * loudly if the guard is removed.
 */
describe('observability', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });

    /**
     * A probe route, registered on the built app before `ready()`.
     *
     * The concurrency assertion needs a handler that yields in the middle and
     * then reports what the ambient context says. No real route does that on
     * demand, and adding one to the application for the benefit of a test would
     * be shipping a debug endpoint. Registered on the root instance, so it
     * inherits exactly the same hooks every real route does.
     */
    app.get<{ Querystring: { delay?: string } }>('/__ctx-probe', async (req) => {
      const before = getRequestId();
      await new Promise((resolve) => setTimeout(resolve, Number(req.query.delay ?? 0)));
      return { before, after: getRequestId() };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const internal = { 'x-internal-token': env.INTERNAL_API_TOKEN };

  async function scrape() {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: internal });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  /** The subset of the Prometheus text format a scraper actually reads. */
  function samples(text: string) {
    const parsed = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{.*\})?) (.+)$/.exec(line);
      expect(match, `unparseable metrics line: ${line}`).not.toBeNull();
      parsed.set(match![1]!, Number(match![2]));
    }
    return parsed;
  }

  describe('request ids', () => {
    it('accepts and echoes an inbound X-Request-Id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { [REQUEST_ID_HEADER]: 'abc' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers[REQUEST_ID_HEADER]).toBe('abc');
    });

    it('generates one when the header is absent, and it is stable within the request', async () => {
      const res = await app.inject({ method: 'GET', url: '/__ctx-probe' });
      const generated = res.headers[REQUEST_ID_HEADER];

      expect(generated).toMatch(/^[0-9a-f-]{36}$/);
      // Same id before and after the handler awaits: an id that changes
      // mid-request correlates nothing.
      expect(res.json()).toEqual({ before: generated, after: generated });
    });

    it('generates a different id for each request', async () => {
      const [a, b] = await Promise.all([
        app.inject({ method: 'GET', url: '/health/live' }),
        app.inject({ method: 'GET', url: '/health/live' }),
      ]);
      expect(a.headers[REQUEST_ID_HEADER]).not.toBe(b.headers[REQUEST_ID_HEADER]);
    });

    it('refuses a 2KB header rather than echoing it', async () => {
      const hostile = 'x'.repeat(2048);
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { [REQUEST_ID_HEADER]: hostile },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers[REQUEST_ID_HEADER]).not.toBe(hostile);
      expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses a header carrying a newline -- the log injection case', async () => {
      // A forged log record, appended to ours. If this were echoed and logged
      // verbatim, an attacker could write whatever they liked into the audit
      // trail and it would be indistinguishable from a real line.
      const forged = 'abc' + String.fromCharCode(10) + '{"level":50,"msg":"payout approved"}';
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { [REQUEST_ID_HEADER]: forged },
      });

      expect(res.statusCode).toBe(200);
      const echoed = String(res.headers[REQUEST_ID_HEADER]);
      expect(echoed).not.toContain('payout approved');
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps two concurrent requests out of one another context', async () => {
      // The test that actually exercises AsyncLocalStorage. Both requests are
      // in flight together and the slower one yields across the faster one's
      // whole lifetime, so a single module-level "current request id" would
      // pass every other test here and fail this one.
      const [slow, fast] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/__ctx-probe?delay=60',
          headers: { [REQUEST_ID_HEADER]: 'slow-request' },
        }),
        app.inject({
          method: 'GET',
          url: '/__ctx-probe?delay=5',
          headers: { [REQUEST_ID_HEADER]: 'fast-request' },
        }),
      ]);

      expect(slow.json()).toEqual({ before: 'slow-request', after: 'slow-request' });
      expect(fast.json()).toEqual({ before: 'fast-request', after: 'fast-request' });
      expect(slow.headers[REQUEST_ID_HEADER]).toBe('slow-request');
      expect(fast.headers[REQUEST_ID_HEADER]).toBe('fast-request');
    });

    it('returns the id in the error body so a support ticket can quote it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/brand/campaigns',
        headers: { [REQUEST_ID_HEADER]: 'ticket-4711' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { requestId: 'ticket-4711' } });
      expect(res.headers[REQUEST_ID_HEADER]).toBe('ticket-4711');
    });
  });

  describe('/metrics', () => {
    it('is refused without the internal token', async () => {
      // The output maps every route, its traffic and its failures. That is not
      // public information, and an unguessable path is not access control.
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(401);

      const wrong = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { 'x-internal-token': 'not-the-token-but-long-enough-x' },
      });
      expect(wrong.statusCode).toBe(401);
    });

    it('is served as Prometheus text and carries the RED triad', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics', headers: internal });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('# TYPE http_requests_total counter');
      expect(res.body).toContain('# TYPE http_request_duration_seconds histogram');
      expect(res.body).toContain('# TYPE db_query_duration_seconds histogram');
      expect(res.body).toContain('# TYPE queue_depth gauge');
      expect(res.body).toContain('# TYPE worker_last_run_timestamp gauge');
    });

    it('counts requests, and the count goes up', async () => {
      const key = 'http_requests_total{method="GET",route="/health/live",status="200"}';
      const before = samples(await scrape()).get(key) ?? 0;

      await app.inject({ method: 'GET', url: '/health/live' });
      await app.inject({ method: 'GET', url: '/health/live' });

      expect(samples(await scrape()).get(key)).toBe(before + 2);
    });

    it('records duration as a histogram with cumulative buckets', async () => {
      await app.inject({ method: 'GET', url: '/health/live' });
      const parsed = samples(await scrape());

      const count = parsed.get(
        'http_request_duration_seconds_count{method="GET",route="/health/live"}'
      );
      const inf = parsed.get(
        'http_request_duration_seconds_bucket{method="GET",route="/health/live",le="+Inf"}'
      );
      const oneSecond = parsed.get(
        'http_request_duration_seconds_bucket{method="GET",route="/health/live",le="1"}'
      );

      expect(count).toBeGreaterThan(0);
      expect(inf).toBe(count);
      expect(oneSecond).toBeLessThanOrEqual(inf!);
    });

    it('labels by route pattern, never by the resolved id', async () => {
      // The whole story of criterion 6. Two ids on the same endpoint must
      // produce one series, not two -- otherwise every campaign a brand ever
      // creates permanently adds a time series.
      const brand = await makeBrand();
      const auth = await login(app, brand.email);
      const one = await makeCampaign(brand.id);
      const two = await makeCampaign(brand.id);

      await app.inject({
        method: 'GET',
        url: `/api/brand/campaigns/${one.id}`,
        headers: auth.authHeader,
      });
      await app.inject({
        method: 'GET',
        url: `/api/brand/campaigns/${two.id}`,
        headers: auth.authHeader,
      });

      const body = await scrape();

      expect(body).toContain('route="/api/brand/campaigns/:id"');
      expect(body).not.toContain(one.id);
      expect(body).not.toContain(two.id);

      const parsed = samples(body);
      expect(
        parsed.get(
          'http_requests_total{method="GET",route="/api/brand/campaigns/:id",status="200"}'
        )
      ).toBeGreaterThanOrEqual(2);
    });

    it('files an unmatched path under one label instead of minting a series per URL', async () => {
      // A scanner walking invented paths must not be able to grow the metrics
      // backend one request at a time.
      await app.inject({ method: 'GET', url: '/api/no-such-route-a' });
      await app.inject({ method: 'GET', url: '/api/no-such-route-b' });

      const body = await scrape();
      expect(body).not.toContain('no-such-route');
      expect(
        samples(body).get(
          'http_requests_total{method="GET",route="__unmatched__",status="404"}'
        )
      ).toBeGreaterThanOrEqual(2);
    });

    it('reports queue depth and worker heartbeats at scrape time', async () => {
      await redis.lpush(QUEUE_KEY, JSON.stringify({ nonsense: true }));

      const parsed = samples(await scrape());
      expect(parsed.get(`queue_depth{queue="${QUEUE_KEY}"}`)).toBe(1);
      // No worker runs in the test process, so the heartbeat is absent and the
      // gauge says zero rather than vanishing -- see the comment on the
      // collector for why an absent series is the worse of the two.
      expect(parsed.get('worker_last_run_timestamp{worker="click-event"}')).toBe(0);
    });

    it('times database queries', async () => {
      await prisma.user.count();
      const parsed = samples(await scrape());
      expect(
        parsed.get('db_query_duration_seconds_count{model="User",operation="count"}')
      ).toBeGreaterThan(0);
    });
  });

  describe('health', () => {
    it('answers liveness without touching a dependency', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
    });

    it('answers readiness with a real Postgres and Redis check', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        checks: { database: { ok: true }, redis: { ok: true } },
      });
    });
  });

  describe('propagation to the click pipeline', () => {
    it('carries the redirect request id onto the ClickEvent row', async () => {
      // Criterion 4, and the reason the id is in the queue payload at all: the
      // click is written by a different process a second later, so the
      // in-process context is long gone and only the payload can carry it.
      const brand = await makeBrand();
      const affiliate = await makeAffiliate();
      const campaign = await makeCampaign(brand.id);
      await makeRelationship(brand.id, affiliate.id);
      const link = await makeTrackingLink(affiliate.id, campaign.id);

      await redis.lpush(
        QUEUE_KEY,
        JSON.stringify({
          trackingLinkId: link.id,
          affiliateId: affiliate.id,
          campaignId: campaign.id,
          cookieId: 'cookie-1',
          timestamp: Date.now(),
          ip: 'hashed',
          userAgent: 'Mozilla/5.0 (test)',
          referrer: '',
          subIds: {},
          requestId: 'redirect-req-77',
        })
      );

      const { flushed } = await drainClickEvents();
      expect(flushed).toBe(1);

      const row = await prisma.clickEvent.findFirst({ where: { trackingLinkId: link.id } });
      expect(row?.requestId).toBe('redirect-req-77');
    });

    it('drops an untrusted request id from the queue but keeps the click', async () => {
      // A correlation id must never be able to cost somebody a paid click, and
      // a producer other than our redirect service is exactly the case the
      // worker cannot assume away.
      const brand = await makeBrand();
      const affiliate = await makeAffiliate();
      const campaign = await makeCampaign(brand.id);
      await makeRelationship(brand.id, affiliate.id);
      const link = await makeTrackingLink(affiliate.id, campaign.id);

      await redis.lpush(
        QUEUE_KEY,
        JSON.stringify({
          trackingLinkId: link.id,
          affiliateId: affiliate.id,
          campaignId: campaign.id,
          cookieId: 'cookie-2',
          timestamp: Date.now(),
          ip: 'hashed',
          userAgent: 'Mozilla/5.0 (test)',
          referrer: '',
          subIds: {},
          requestId: 'evil' + String.fromCharCode(10) + '{"msg":"forged"}',
        })
      );

      const { flushed } = await drainClickEvents();
      expect(flushed).toBe(1);

      const row = await prisma.clickEvent.findFirst({ where: { trackingLinkId: link.id } });
      expect(row).not.toBeNull();
      expect(row?.requestId).toBeNull();
    });
  });
});
