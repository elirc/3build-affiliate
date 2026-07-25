import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { QUEUE_KEY, drainClickEvents } from '../src/workers/click-event.worker';
import {
  login,
  makeAffiliate,
  makeApiKey,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
  postbackHeaders,
} from './factories';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SLACKBOT = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';

describe('bot and duplicate click filtering', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function scenario() {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);
    return {
      brand,
      campaign,
      affiliate,
      link,
      key,
      brandAuth: await login(app, brand.email),
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /**
   * Pushes a click without the redirect service's own classification, so the
   * worker has to do it. That is the path a payload from an older redirect
   * deploy takes.
   */
  async function queueClick(
    s: Scenario,
    userAgent: string,
    extra: Record<string, unknown> = {}
  ) {
    await redis.lpush(
      QUEUE_KEY,
      JSON.stringify({
        trackingLinkId: s.link.id,
        affiliateId: s.affiliate.id,
        campaignId: s.campaign.id,
        cookieId: 'cookie-1',
        timestamp: Date.now() - 3600 * 1000,
        ip: 'hash',
        userAgent,
        referrer: '',
        subIds: {},
        ...extra,
      })
    );
    await drainClickEvents();
  }

  it('records a bot click but does not count it', async () => {
    // Rows are kept deliberately: deleting the evidence makes the filtered
    // totals unverifiable, and "your post was previewed 40 times" is useful.
    const s = await scenario();
    await queueClick(s, GOOGLEBOT);

    const event = await prisma.clickEvent.findFirstOrThrow();
    expect(event.trafficKind).toBe('crawler');
    expect(event.isCounted).toBe(false);

    const link = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: s.link.id },
    });
    expect(link.clickCount).toBe(0);
  });

  it('counts a real browser', async () => {
    const s = await scenario();
    await queueClick(s, CHROME);

    const event = await prisma.clickEvent.findFirstOrThrow();
    expect(event.trafficKind).toBe('human');
    expect(event.isCounted).toBe(true);

    const link = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: s.link.id },
    });
    expect(link.clickCount).toBe(1);
  });

  it('separates link previews from crawlers', async () => {
    const s = await scenario();
    await queueClick(s, SLACKBOT);

    const event = await prisma.clickEvent.findFirstOrThrow();
    expect(event.trafficKind).toBe('preview');
    expect(event.isCounted).toBe(false);
  });

  it('classifies a payload that arrives without a verdict', async () => {
    // A producer that predates this feature -- or anything else writing to
    // the queue -- must not default to "human".
    const s = await scenario();
    await queueClick(s, GOOGLEBOT, { trafficKind: undefined, isCounted: undefined });

    expect((await prisma.clickEvent.findFirstOrThrow()).isCounted).toBe(false);
  });

  it('ignores an unrecognised traffic kind rather than trusting it', async () => {
    const s = await scenario();
    await queueClick(s, GOOGLEBOT, { trafficKind: 'definitely-a-human' });

    const event = await prisma.clickEvent.findFirstOrThrow();
    expect(event.trafficKind).toBe('crawler');
  });

  it('never attributes a conversion to a bot click', async () => {
    // The expensive failure: a crawler that happened to touch a link inside
    // the window becoming the click a real sale is credited to.
    const s = await scenario();
    await queueClick(s, GOOGLEBOT);

    const body = JSON.stringify({
      externalOrderId: 'order-1',
      conversionValue: 100,
      attributionCookieId: 'cookie-1',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });

    expect(res.statusCode).toBe(422);
    expect(await prisma.conversion.count()).toBe(0);
  });

  it('still attributes to a human click alongside bot traffic', async () => {
    const s = await scenario();
    await queueClick(s, GOOGLEBOT);
    await queueClick(s, CHROME);

    const body = JSON.stringify({
      externalOrderId: 'order-1',
      conversionValue: 100,
      attributionCookieId: 'cookie-1',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });

    expect(res.statusCode).toBe(201);
  });

  it('excludes uncounted clicks from analytics', async () => {
    const s = await scenario();
    await queueClick(s, CHROME);
    await queueClick(s, GOOGLEBOT);
    await queueClick(s, SLACKBOT);

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7',
      headers: s.brandAuth.authHeader,
    });

    // Three rows in the table, one click in the numbers.
    expect(await prisma.clickEvent.count()).toBe(3);
    expect((res.json() as { totals: { clicks: number } }).totals.clicks).toBe(1);
  });

  it('excludes uncounted clicks from the breakdown tables', async () => {
    const s = await scenario();
    await queueClick(s, CHROME);
    await queueClick(s, GOOGLEBOT);

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns',
      headers: s.brandAuth.authHeader,
    });

    const row = (res.json() as Array<{ campaignId: string; totalClicks: number }>).find(
      (r) => r.campaignId === s.campaign.id
    )!;
    expect(row.totalClicks).toBe(1);
  });

  it('honours a duplicate verdict from the edge', async () => {
    // Deduplication happens at the redirect, where the Redis SET NX lives.
    // The worker's job is to respect the verdict, not to re-derive it.
    const s = await scenario();
    await queueClick(s, CHROME);
    await queueClick(s, CHROME, { isCounted: false });

    expect(await prisma.clickEvent.count()).toBe(2);
    const link = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: s.link.id },
    });
    expect(link.clickCount).toBe(1);
  });
});
