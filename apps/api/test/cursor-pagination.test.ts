import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * Keyset pagination over conversions.
 *
 * The headline test is `does not repeat or skip rows when data arrives
 * mid-page`. It fails against offset pagination, which is the point: offset is
 * not merely slower, it returns *wrong* answers whenever the underlying set
 * changes between requests -- and it does so silently.
 */
describe('cursor pagination', () => {
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
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    return { brand, campaign, affiliate, link, auth: await login(app, brand.email) };
  }

  /** `at` controls ordering; conversions are listed `occurredAt desc`. */
  async function conversion(
    s: Awaited<ReturnType<typeof scenario>>,
    order: string,
    at: Date
  ) {
    return prisma.conversion.create({
      data: {
        trackingLinkId: s.link.id,
        campaignId: s.campaign.id,
        affiliateId: s.affiliate.id,
        externalOrderId: order,
        conversionValue: '100.00',
        commissionAmount: '10.00',
        status: 'PENDING',
        occurredAt: at,
      },
    });
  }

  function page(
    s: Awaited<ReturnType<typeof scenario>>,
    opts: { cursor?: string; pageSize?: number } = {}
  ) {
    // No cursor on the first request: the seek starts from the top.
    const qs = opts.cursor
      ? `pageSize=${opts.pageSize ?? 5}&cursor=${encodeURIComponent(opts.cursor)}`
      : `pageSize=${opts.pageSize ?? 5}`;

    return app.inject({
      method: 'GET',
      url: `/api/brand/conversions?${qs}`,
      headers: { ...s.auth.authHeader, 'x-pagination': 'cursor' },
    });
  }

  interface Page {
    data: Array<{ id: string; externalOrderId: string }>;
    nextCursor: string | null;
    hasMore: boolean;
  }

  it('walks the whole set exactly once', async () => {
    const s = await scenario();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 23; i++) {
      await conversion(s, `order-${i}`, new Date(base + i * 60_000));
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 20; guard++) {
      const res = await page(s, { cursor, pageSize: 5 });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Page;

      seen.push(...body.data.map((r) => r.externalOrderId));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it('does not repeat or skip rows when data arrives mid-page', async () => {
    // The test that justifies the whole story.
    //
    // With offset paging, three conversions inserted between page 1 and page 2
    // land at the top of a `occurredAt desc` list and shift everything down by
    // three -- so rows 3, 4 and 5 of page 1 appear *again* on page 2. A client
    // paging through to sum commissions gets a wrong number and no error.
    const s = await scenario();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 10; i++) {
      await conversion(s, `original-${i}`, new Date(base + i * 60_000));
    }

    const first = (await page(s, { pageSize: 5 })).json() as Page;
    expect(first.data).toHaveLength(5);

    // Newer than everything, so they sort to the very top.
    for (let i = 0; i < 3; i++) {
      await conversion(s, `arrived-${i}`, new Date(base + 3_600_000 + i * 60_000));
    }

    const second = (await page(s, { cursor: first.nextCursor!, pageSize: 5 })).json() as Page;

    const firstIds = first.data.map((r) => r.id);
    const secondIds = second.data.map((r) => r.id);
    const overlap = secondIds.filter((id) => firstIds.includes(id));

    expect(overlap).toEqual([]);

    // And page 2 is the genuine continuation, not a window shifted by the
    // three arrivals.
    expect(second.data.map((r) => r.externalOrderId)).toEqual([
      'original-4',
      'original-3',
      'original-2',
      'original-1',
      'original-0',
    ]);
  });

  it('gives a null cursor on the final page', async () => {
    const s = await scenario();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    // Exactly one full page: the case where "did I get pageSize rows?" is the
    // wrong way to detect the end.
    for (let i = 0; i < 5; i++) {
      await conversion(s, `order-${i}`, new Date(base + i * 60_000));
    }

    const body = (await page(s, { pageSize: 5 })).json() as Page;

    expect(body.data).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('orders deterministically when timestamps collide', async () => {
    // `occurredAt` is not unique. Without `id` as a tie-breaker the sort is
    // not a total order, two rows sharing a millisecond can swap between
    // requests, and a cursor pointing at either is ambiguous.
    const s = await scenario();
    const same = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 6; i++) await conversion(s, `same-${i}`, same);

    const runs = await Promise.all([
      page(s, { pageSize: 3 }),
      page(s, { pageSize: 3 }),
      page(s, { pageSize: 3 }),
    ]);

    const orders = runs.map((r) => (r.json() as Page).data.map((x) => x.id).join(','));
    expect(new Set(orders).size).toBe(1);

    // And paging through collided rows still yields each exactly once.
    const firstPage = (runs[0]!.json() as Page);
    const nextPage = (await page(s, { cursor: firstPage.nextCursor!, pageSize: 3 })).json() as Page;
    const all = [...firstPage.data, ...nextPage.data].map((r) => r.id);
    expect(new Set(all).size).toBe(6);
  });

  it('rejects a tampered cursor with a 400, not a 500', async () => {
    const s = await scenario();
    await conversion(s, 'order-0', new Date());

    const res = await page(s, { cursor: 'this-is-not-a-cursor' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });

  it('still serves offset pagination for one release', async () => {
    // Breaking the web client in the same change that adds the replacement
    // would make a correctness fix look like an outage.
    const s = await scenario();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 7; i++) {
      await conversion(s, `order-${i}`, new Date(base + i * 60_000));
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions?page=2&pageSize=5',
      headers: s.auth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    // The old shape: a bare array, not a cursor page.
    expect(Array.isArray(res.json())).toBe(true);
    expect((res.json() as unknown[]).length).toBe(2);
  });

  it('keeps one brand out of another brand\'s conversions', async () => {
    const mine = await scenario();
    const theirs = await scenario();
    await conversion(mine, 'mine-0', new Date());
    await conversion(theirs, 'theirs-0', new Date());

    const body = (await page(mine, { pageSize: 10 })).json() as Page;

    expect(body.data.map((r) => r.externalOrderId)).toEqual(['mine-0']);
  });
});
