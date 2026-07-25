import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { drainClickEvents } from '../src/workers/click-event.worker';
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

describe('sub-ID reporting', () => {
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
      auth: await login(app, affiliate.email),
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** Pushes a click through the same queue the redirect service uses. */
  async function click(
    s: Scenario,
    cookieId: string,
    subIds: Record<string, string>
  ) {
    await redis.lpush(
      'click_events',
      JSON.stringify({
        trackingLinkId: s.link.id,
        affiliateId: s.affiliate.id,
        campaignId: s.campaign.id,
        cookieId,
        timestamp: Date.now() - 3600 * 1000,
        ip: 'hash',
        userAgent: 'Mozilla/5.0 (test)',
        referrer: '',
        subIds,
      })
    );
    await drainClickEvents();
  }

  async function convert(s: Scenario, cookieId: string, orderId: string, value = 100) {
    const body = JSON.stringify({
      externalOrderId: orderId,
      conversionValue: value,
      attributionCookieId: cookieId,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    await prisma.conversion.updateMany({
      where: { externalOrderId: orderId },
      data: { status: 'APPROVED' },
    });
  }

  it('stores sub-IDs on the click', async () => {
    const s = await scenario();
    await click(s, 'c1', { subid: 'newsletter', placement: 'header' });

    const event = await prisma.clickEvent.findFirstOrThrow();
    expect(event.subIds).toEqual({ subid: 'newsletter', placement: 'header' });
  });

  it('carries sub-IDs from the click onto the conversion', async () => {
    // This is what makes revenue attributable to a placement. Without the
    // snapshot the only route back is clickEventId, which is nullable and
    // points at a row that may be pruned long before the commission is paid.
    const s = await scenario();
    await click(s, 'c1', { subid: 'youtube' });
    await convert(s, 'c1', 'order-1');

    const conversion = await prisma.conversion.findFirstOrThrow();
    expect(conversion.subIds).toEqual({ subid: 'youtube' });
  });

  it('reports revenue grouped by sub-ID value', async () => {
    const s = await scenario();

    await click(s, 'yt-1', { subid: 'youtube' });
    await click(s, 'yt-2', { subid: 'youtube' });
    await click(s, 'nl-1', { subid: 'newsletter' });

    await convert(s, 'yt-1', 'order-yt', 200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/subids?key=subid',
      headers: s.auth.authHeader,
    });

    const rows = res.json() as Array<{
      value: string;
      totalClicks: number;
      totalConversions: number;
      totalRevenue: string;
    }>;

    const youtube = rows.find((r) => r.value === 'youtube')!;
    const newsletter = rows.find((r) => r.value === 'newsletter')!;

    expect(youtube.totalClicks).toBe(2);
    expect(youtube.totalConversions).toBe(1);
    expect(youtube.totalRevenue).toBe('200.00');

    // A tag with clicks and no conversions still appears -- that is the
    // finding, and dropping the row hides it.
    expect(newsletter.totalClicks).toBe(1);
    expect(newsletter.totalConversions).toBe(0);
  });

  it('does not multiply clicks by conversions', async () => {
    // Same fan-out trap as the campaign breakdowns: 3 clicks and 2
    // conversions on one tag must not report 6 of each.
    const s = await scenario();
    await click(s, 'a', { subid: 'blog' });
    await click(s, 'b', { subid: 'blog' });
    await click(s, 'c', { subid: 'blog' });
    await convert(s, 'a', 'o-a');
    await convert(s, 'b', 'o-b');

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/subids?key=subid',
      headers: s.auth.authHeader,
    });

    const row = (res.json() as Array<{ value: string; totalClicks: number; totalConversions: number }>)
      .find((r) => r.value === 'blog')!;
    expect(row.totalClicks).toBe(3);
    expect(row.totalConversions).toBe(2);
  });

  it('lists the keys an affiliate has actually used', async () => {
    const s = await scenario();
    await click(s, 'c1', { subid: 'a', placement: 'b' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/subids/keys',
      headers: s.auth.authHeader,
    });
    expect(res.json()).toEqual(['placement', 'subid']);
  });

  it('caps the number of sub-IDs stored', async () => {
    const s = await scenario();
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, `v${i}`])
    );
    await click(s, 'c1', many);

    const event = await prisma.clickEvent.findFirstOrThrow();
    // An unbounded JSON column on the busiest endpoint in the system lets
    // anyone grow the database a request at a time.
    expect(Object.keys(event.subIds as object)).toHaveLength(5);
  });

  it('never shows one affiliate another’s sub-IDs', async () => {
    const s = await scenario();
    await click(s, 'c1', { subid: 'private' });

    const stranger = await makeAffiliate();
    const strangerAuth = await login(app, stranger.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/subids?key=subid',
      headers: strangerAuth.authHeader,
    });
    expect(res.json()).toHaveLength(0);
  });

  it('requires a key', async () => {
    const s = await scenario();
    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/subids',
      headers: s.auth.authHeader,
    });
    expect(res.statusCode).toBe(400);
  });

  it('treats a key as data, not as SQL', async () => {
    // A JSON key *can* be a bind parameter, unlike a column name, so there is
    // no reason to interpolate it -- and this proves it is not.
    const s = await scenario();
    await click(s, 'c1', { subid: 'x' });

    const res = await app.inject({
      method: 'GET',
      url:
        '/api/affiliate/analytics/subids?key=' +
        encodeURIComponent("subid'; DROP TABLE \"User\"; --"),
      headers: s.auth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });
});
