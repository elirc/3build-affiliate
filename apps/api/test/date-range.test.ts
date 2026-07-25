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

describe('date ranges and period comparison', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400 * 1000);

  /**
   * 2 clicks in the last 7 days, 4 in the 7 days before that.
   *
   * Deliberately a decline, so a comparison that silently returns the current
   * period twice would show 0% and be obviously wrong.
   */
  async function scenario() {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    for (const d of [1, 3]) {
      await makeClickEvent(link.id, { timestamp: daysAgo(d) });
    }
    for (const d of [8, 9, 10, 12]) {
      await makeClickEvent(link.id, { timestamp: daysAgo(d) });
    }

    return { brand, campaign, affiliate, auth: await login(app, brand.email) };
  }

  it('still honours the legacy days parameter', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7',
      headers: s.auth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { totals: { clicks: number } }).totals.clicks).toBe(2);
  });

  it('accepts an explicit from and to', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url:
        `/api/brand/analytics?from=${daysAgo(14).toISOString()}` +
        `&to=${daysAgo(7).toISOString()}`,
      headers: s.auth.authHeader,
    });

    // The four older clicks, none of the recent two.
    expect((res.json() as { totals: { clicks: number } }).totals.clicks).toBe(4);
  });

  it('compares against the immediately preceding window', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7&compare=true',
      headers: s.auth.authHeader,
    });

    const body = res.json() as {
      totals: { clicks: number };
      comparison: {
        clicks: { current: number; previous: number; changePercent: number; direction: string };
      };
    };

    expect(body.totals.clicks).toBe(2);
    expect(body.comparison.clicks.previous).toBe(4);
    expect(body.comparison.clicks.changePercent).toBe(-50);
    expect(body.comparison.clicks.direction).toBe('down');
  });

  it('omits the comparison unless asked', async () => {
    // It doubles the query cost, and most callers do not need it.
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7',
      headers: s.auth.authHeader,
    });

    expect(res.json()).not.toHaveProperty('comparison');
  });

  it('returns a previous-period series for the chart overlay', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7&compare=true',
      headers: s.auth.authHeader,
    });

    const body = res.json() as {
      series: unknown[];
      comparison: { series: unknown[]; range: { start: string; end: string } };
    };

    expect(body.comparison.series.length).toBe(body.series.length);
    // The previous window ends before the current one starts.
    expect(new Date(body.comparison.range.end).getTime()).toBeLessThan(
      Date.now() - 7 * 86400 * 1000
    );
  });

  it('reports growth from zero as new rather than as a percentage', async () => {
    // A brand with no history at all: any increase is infinite, and both
    // "∞%" and "100%" would be lies.
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    await makeClickEvent(link.id, { timestamp: daysAgo(1) });

    const auth = await login(app, brand.email);
    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7&compare=true',
      headers: auth.authHeader,
    });

    const clicks = (res.json() as {
      comparison: { clicks: { changePercent: number | null; direction: string } };
    }).comparison.clicks;

    expect(clicks.changePercent).toBeNull();
    expect(clicks.direction).toBe('new');
  });

  it('rejects a range longer than a year', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: `/api/brand/analytics?from=${new Date('2020-01-01').toISOString()}`,
      headers: s.auth.authHeader,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_RANGE'
    );
  });

  it('rejects an inverted range', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url:
        `/api/brand/analytics?from=${daysAgo(1).toISOString()}` +
        `&to=${daysAgo(10).toISOString()}`,
      headers: s.auth.authHeader,
    });

    expect(res.statusCode).toBe(400);
  });

  it('echoes the resolved range back', async () => {
    // So a client can show what it actually got rather than what it asked
    // for -- they differ whenever a default or a cap applies.
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/analytics?days=7',
      headers: s.auth.authHeader,
    });

    const body = res.json() as { range: { start: string; end: string } };
    expect(new Date(body.range.start).getTime()).toBeLessThan(
      new Date(body.range.end).getTime()
    );
  });

  it('works the same way for affiliates', async () => {
    const s = await scenario();
    const affiliateAuth = await login(app, s.affiliate.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/analytics?days=7&compare=true',
      headers: affiliateAuth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('comparison');
    expect(await prisma.clickEvent.count()).toBe(6);
  });
});
