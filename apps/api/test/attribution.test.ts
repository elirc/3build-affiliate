import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  makeAffiliate,
  makeApiKey,
  makeBrand,
  makeCampaign,
  makeClickEvent,
  makeRelationship,
  makeTrackingLink,
  postbackHeaders,
} from './factories';

/**
 * Attribution and commission maths, end to end.
 *
 * `packages/analytics` already unit-tests `attribute()` and
 * `calculateCommission()` in isolation. These tests check the wiring around
 * them: that the right clicks are selected from the database, that the window
 * is applied, that split conversions get distinct order ids, and that the
 * money adds up once it has been through Postgres' Decimal columns.
 */
describe('attribution', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function report(
    campaignId: string,
    payload: Record<string, unknown>,
    keyId: string,
    secret: string
  ) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: `/api/conversions/${campaignId}`,
      headers: postbackHeaders(keyId, secret, body),
      payload: body,
    });
  }

  async function scenario(
    model: 'FIRST_CLICK' | 'LAST_CLICK' | 'LINEAR',
    opts: { windowDays?: number } = {}
  ) {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, {
      attributionModel: model,
      attributionWindowDays: opts.windowDays ?? 30,
      lockPeriodDays: 0,
    });

    const first = await makeAffiliate();
    const second = await makeAffiliate();
    await makeRelationship(brand.id, first.id);
    await makeRelationship(brand.id, second.id);

    const firstLink = await makeTrackingLink(first.id, campaign.id);
    const secondLink = await makeTrackingLink(second.id, campaign.id);

    const key = await makeApiKey(campaign.id);
    return { campaign, first, second, firstLink, secondLink, key };
  }

  const COOKIE = 'shared-cookie';
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

  it('credits the earliest click under FIRST_CLICK', async () => {
    const s = await scenario('FIRST_CLICK');
    await makeClickEvent(s.firstLink.id, { cookieId: COOKIE, timestamp: hoursAgo(5) });
    await makeClickEvent(s.secondLink.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });

    const res = await report(
      s.campaign.id,
      { externalOrderId: 'o1', conversionValue: 100, attributionCookieId: COOKIE },
      s.key.keyId,
      s.key.secret
    );
    expect(res.statusCode).toBe(201);

    const conversions = await prisma.conversion.findMany({
      where: { campaignId: s.campaign.id },
    });
    expect(conversions).toHaveLength(1);
    expect(conversions[0]!.affiliateId).toBe(s.first.id);
  });

  it('credits the most recent click under LAST_CLICK', async () => {
    const s = await scenario('LAST_CLICK');
    await makeClickEvent(s.firstLink.id, { cookieId: COOKIE, timestamp: hoursAgo(5) });
    await makeClickEvent(s.secondLink.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });

    await report(
      s.campaign.id,
      { externalOrderId: 'o1', conversionValue: 100, attributionCookieId: COOKIE },
      s.key.keyId,
      s.key.secret
    );

    const conversions = await prisma.conversion.findMany({
      where: { campaignId: s.campaign.id },
    });
    expect(conversions).toHaveLength(1);
    expect(conversions[0]!.affiliateId).toBe(s.second.id);
  });

  it('splits value and commission evenly under LINEAR', async () => {
    const s = await scenario('LINEAR');
    await makeClickEvent(s.firstLink.id, { cookieId: COOKIE, timestamp: hoursAgo(5) });
    await makeClickEvent(s.secondLink.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });

    await report(
      s.campaign.id,
      { externalOrderId: 'o1', conversionValue: 100, attributionCookieId: COOKIE },
      s.key.keyId,
      s.key.secret
    );

    const conversions = await prisma.conversion.findMany({
      where: { campaignId: s.campaign.id },
      orderBy: { affiliateId: 'asc' },
    });
    expect(conversions).toHaveLength(2);

    // The split must not invent or lose money.
    const totalValue = conversions.reduce((sum, c) => sum + Number(c.conversionValue), 0);
    expect(totalValue).toBe(100);

    const totalCommission = conversions.reduce(
      (sum, c) => sum + Number(c.commissionAmount),
      0
    );
    expect(totalCommission).toBe(20); // 20% of 100

    // Split rows get suffixed order ids, because (campaignId, externalOrderId)
    // is unique and both halves came from one order.
    for (const c of conversions) {
      expect(c.externalOrderId).toMatch(/^o1:/);
    }
  });

  it('ignores clicks older than the attribution window', async () => {
    const s = await scenario('LAST_CLICK', { windowDays: 1 });
    await makeClickEvent(s.firstLink.id, { cookieId: COOKIE, timestamp: hoursAgo(48) });

    const res = await report(
      s.campaign.id,
      { externalOrderId: 'o1', conversionValue: 100, attributionCookieId: COOKIE },
      s.key.keyId,
      s.key.secret
    );

    expect(res.statusCode).toBe(422);
    expect(await prisma.conversion.count()).toBe(0);
  });

  it('ignores clicks on a different campaign', async () => {
    const s = await scenario('LAST_CLICK');
    const otherBrand = await makeBrand();
    const otherCampaign = await makeCampaign(otherBrand.id);
    await makeRelationship(otherBrand.id, s.first.id);
    const otherLink = await makeTrackingLink(s.first.id, otherCampaign.id);

    // Same shopper, same cookie, but the click was on someone else's campaign.
    await makeClickEvent(otherLink.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });

    const res = await report(
      s.campaign.id,
      { externalOrderId: 'o1', conversionValue: 100, attributionCookieId: COOKIE },
      s.key.keyId,
      s.key.secret
    );

    expect(res.statusCode).toBe(422);
  });

  it('refuses a duplicate order id and creates nothing the second time', async () => {
    const s = await scenario('LAST_CLICK');
    await makeClickEvent(s.firstLink.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });

    const payload = {
      externalOrderId: 'same-order',
      conversionValue: 100,
      attributionCookieId: COOKIE,
    };

    const first = await report(s.campaign.id, payload, s.key.keyId, s.key.secret);
    expect(first.statusCode).toBe(201);

    // A storefront webhook that retries on timeout must not double-pay.
    const second = await report(s.campaign.id, payload, s.key.keyId, s.key.secret);
    expect(second.statusCode).toBe(409);

    expect(await prisma.conversion.count({ where: { campaignId: s.campaign.id } })).toBe(1);
  });

  it('applies tiered rates from the affiliate’s prior approved sales', async () => {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, {
      lockPeriodDays: 0,
      commissionStructure: {
        type: 'tiered_percentage',
        tiers: [
          { minSales: 0, percentage: 10 },
          { minSales: 2, percentage: 30 },
        ],
      },
    });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);

    // Two already-approved sales put this affiliate into the second tier.
    for (const n of [1, 2]) {
      await prisma.conversion.create({
        data: {
          trackingLinkId: link.id,
          campaignId: campaign.id,
          affiliateId: affiliate.id,
          externalOrderId: `historic-${n}`,
          conversionValue: '100.00',
          commissionAmount: '10.00',
          status: 'APPROVED',
          occurredAt: new Date(),
        },
      });
    }

    await makeClickEvent(link.id, { cookieId: COOKIE, timestamp: hoursAgo(1) });
    await report(
      campaign.id,
      { externalOrderId: 'tiered', conversionValue: 100, attributionCookieId: COOKIE },
      key.keyId,
      key.secret
    );

    const conversion = await prisma.conversion.findFirstOrThrow({
      where: { externalOrderId: 'tiered' },
    });
    expect(Number(conversion.commissionAmount)).toBe(30);
  });
});
