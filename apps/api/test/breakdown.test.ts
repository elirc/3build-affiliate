import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeClickEvent,
  makeRelationship,
  makeTrackingLink,
} from './factories';

describe('performance breakdowns', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * One campaign with 3 clicks and 2 approved conversions, plus a second
   * campaign with 1 click and nothing else.
   *
   * The 3-and-2 shape is deliberate: a query that joins clicks and conversions
   * to the same rows reports 6 of each, which looks plausible enough to ship.
   */
  async function scenario() {
    const brand = await makeBrand();
    const busy = await makeCampaign(brand.id);
    const quiet = await makeCampaign(brand.id);

    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const busyLink = await makeTrackingLink(affiliate.id, busy.id);
    const quietLink = await makeTrackingLink(affiliate.id, quiet.id);

    for (let i = 0; i < 3; i++) await makeClickEvent(busyLink.id);
    await makeClickEvent(quietLink.id);

    for (let i = 0; i < 2; i++) {
      await prisma.conversion.create({
        data: {
          trackingLinkId: busyLink.id,
          campaignId: busy.id,
          affiliateId: affiliate.id,
          externalOrderId: `o-${i}-${Math.random().toString(36).slice(2)}`,
          conversionValue: '100.00',
          commissionAmount: '20.00',
          status: 'APPROVED',
          occurredAt: new Date(),
        },
      });
    }

    return {
      brand,
      busy,
      quiet,
      affiliate,
      brandAuth: await login(app, brand.email),
      affiliateAuth: await login(app, affiliate.email),
    };
  }

  it('does not multiply clicks by conversions', async () => {
    // The fan-out bug. 3 clicks and 2 conversions must not report 6 of each.
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns',
      headers: s.brandAuth.authHeader,
    });

    const rows = res.json() as Array<{
      campaignId: string;
      totalClicks: number;
      totalConversions: number;
      totalRevenue: string;
    }>;
    const busy = rows.find((r) => r.campaignId === s.busy.id)!;

    expect(busy.totalClicks).toBe(3);
    expect(busy.totalConversions).toBe(2);
    expect(busy.totalRevenue).toBe('200.00');
  });

  it('includes campaigns with no activity as zeroes', async () => {
    // A campaign that produced nothing is a finding. Dropping it from the
    // table makes it look like it was never launched.
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns',
      headers: s.brandAuth.authHeader,
    });

    const rows = res.json() as Array<{ campaignId: string; totalConversions: number }>;
    const quiet = rows.find((r) => r.campaignId === s.quiet.id);
    expect(quiet).toBeDefined();
    expect(quiet!.totalConversions).toBe(0);
  });

  it('computes conversion rate and EPC without dividing by zero', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns',
      headers: s.brandAuth.authHeader,
    });

    const rows = res.json() as Array<{
      campaignId: string;
      conversionRate: number;
      epc: string;
    }>;
    const busy = rows.find((r) => r.campaignId === s.busy.id)!;
    const quiet = rows.find((r) => r.campaignId === s.quiet.id)!;

    expect(busy.conversionRate).toBeCloseTo(66.67, 1); // 2 of 3
    expect(busy.epc).toBe('13.33'); // $40 over 3 clicks
    // One click, nothing else: not NaN, not Infinity.
    expect(quiet.conversionRate).toBe(0);
    expect(quiet.epc).toBe('0.00');
  });

  it('excludes pending conversions unless asked', async () => {
    const s = await scenario();
    const link = await prisma.trackingLink.findFirstOrThrow({
      where: { campaignId: s.busy.id },
    });
    await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: s.busy.id,
        affiliateId: s.affiliate.id,
        externalOrderId: 'pending-1',
        conversionValue: '500.00',
        commissionAmount: '100.00',
        status: 'PENDING',
        occurredAt: new Date(),
      },
    });

    const confirmed = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns',
      headers: s.brandAuth.authHeader,
    });
    const booked = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns?includePending=true',
      headers: s.brandAuth.authHeader,
    });

    const revenueOf = (r: { body: string }) =>
      (JSON.parse(r.body) as Array<{ campaignId: string; totalRevenue: string }>).find(
        (x) => x.campaignId === s.busy.id
      )!.totalRevenue;

    // "Booked" versus "confirmed" is the most common support question in an
    // affiliate programme, so the difference has to be visible.
    expect(revenueOf(confirmed)).toBe('200.00');
    expect(revenueOf(booked)).toBe('700.00');
  });

  it('ignores an injected sort key instead of executing it', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url:
        '/api/brand/analytics/campaigns?sort=' +
        encodeURIComponent('total_clicks; DROP TABLE "User"; --'),
      headers: s.brandAuth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    // Still there.
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });

  it('sorts by a whitelisted key', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/campaigns?sort=clicks&direction=desc',
      headers: s.brandAuth.authHeader,
    });

    const rows = res.json() as Array<{ campaignId: string; totalClicks: number }>;
    expect(rows[0]!.campaignId).toBe(s.busy.id);
    expect(rows[0]!.totalClicks).toBeGreaterThanOrEqual(rows[1]!.totalClicks);
  });

  it('breaks down by affiliate for a brand', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/affiliates',
      headers: s.brandAuth.authHeader,
    });

    const rows = res.json() as Array<{
      affiliateId: string;
      affiliateName: string;
      totalClicks: number;
      totalConversions: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.affiliateId).toBe(s.affiliate.id);
    expect(rows[0]!.totalClicks).toBe(4);
    expect(rows[0]!.totalConversions).toBe(2);
    expect(rows[0]!.affiliateName).toContain('Affie');
  });

  it('never shows one brand another brand’s numbers', async () => {
    const s = await scenario();
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    for (const url of [
      '/api/brand/analytics/campaigns',
      '/api/brand/analytics/affiliates',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: otherAuth.authHeader });
      expect(res.json(), url).toHaveLength(0);
    }
  });

  it('gives an affiliate their own campaign and link breakdowns', async () => {
    const s = await scenario();

    const campaigns = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/campaigns',
      headers: s.affiliateAuth.authHeader,
    });
    expect(campaigns.json()).toHaveLength(2);

    const links = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics/links',
      headers: s.affiliateAuth.authHeader,
    });
    const rows = links.json() as Array<{ shortCode: string; totalClicks: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.totalClicks).toBe(3);
  });

  it('keeps brand breakdowns away from affiliates', async () => {
    const s = await scenario();
    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics/affiliates',
      headers: s.affiliateAuth.authHeader,
    });
    expect(res.statusCode).toBe(403);
  });
});
