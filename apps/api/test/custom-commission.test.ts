import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAffiliate,
  makeApiKey,
  makeBrand,
  makeCampaign,
  makeClickEvent,
  makeRelationship,
  makeTrackingLink,
  postbackHeaders,
} from './factories';

describe('per-affiliate commission overrides', () => {
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
    // Campaign default is 20%.
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
    const affiliate = await makeAffiliate();
    const relationship = await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);
    const brandAuth = await login(app, brand.email);
    const affiliateAuth = await login(app, affiliate.email);
    return { brand, campaign, affiliate, relationship, link, key, brandAuth, affiliateAuth };
  }

  async function sell(
    s: Awaited<ReturnType<typeof scenario>>,
    orderId: string,
    value = 100
  ) {
    const cookie = `cookie-${orderId}`;
    await makeClickEvent(s.link.id, {
      cookieId: cookie,
      timestamp: new Date(Date.now() - 3600 * 1000),
    });
    const body = JSON.stringify({
      externalOrderId: orderId,
      conversionValue: value,
      attributionCookieId: cookie,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return prisma.conversion.findFirstOrThrow({ where: { externalOrderId: orderId } });
  }

  function setRate(
    s: Awaited<ReturnType<typeof scenario>>,
    structure: object | null
  ) {
    return app.inject({
      method: 'PUT',
      url: `/api/brand/affiliates/${s.relationship.id}/commission`,
      headers: s.brandAuth.authHeader,
      payload: { commissionStructure: structure },
    });
  }

  it('uses the campaign rate when no override is set', async () => {
    const s = await scenario();
    const conv = await sell(s, 'order-default');
    expect(Number(conv.commissionAmount)).toBe(20); // 20% of 100
  });

  it('uses the override once one is set', async () => {
    const s = await scenario();
    const res = await setRate(s, { type: 'percentage', percentage: 35 });
    expect(res.statusCode).toBe(200);

    const conv = await sell(s, 'order-override');
    expect(Number(conv.commissionAmount)).toBe(35);
  });

  it('does not recalculate commissions recorded before the change', async () => {
    // An affiliate paid 20% on a sale last month was paid correctly at the
    // time. Retroactively rewriting it would mean a brand could change what
    // they already owe.
    const s = await scenario();
    const before = await sell(s, 'order-before');
    expect(Number(before.commissionAmount)).toBe(20);

    await setRate(s, { type: 'percentage', percentage: 35 });

    const unchanged = await prisma.conversion.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(Number(unchanged.commissionAmount)).toBe(20);

    const after = await sell(s, 'order-after');
    expect(Number(after.commissionAmount)).toBe(35);
  });

  it('restores the campaign rate when the override is cleared', async () => {
    const s = await scenario();
    await setRate(s, { type: 'percentage', percentage: 35 });
    const cleared = await setRate(s, null);
    expect(cleared.statusCode).toBe(200);

    const relationship = await prisma.brandAffiliate.findUniqueOrThrow({
      where: { id: s.relationship.id },
    });
    expect(relationship.customCommission).toBeNull();

    const conv = await sell(s, 'order-cleared');
    expect(Number(conv.commissionAmount)).toBe(20);
  });

  it('supports a different structure type as an override', async () => {
    const s = await scenario();
    await setRate(s, { type: 'flat_per_sale', flatAmount: 12.5 });

    const conv = await sell(s, 'order-flat', 500);
    // Flat, so the order value does not matter.
    expect(Number(conv.commissionAmount)).toBe(12.5);
  });

  it('records who changed the rate and what it was before', async () => {
    const s = await scenario();
    await setRate(s, { type: 'percentage', percentage: 30 });
    await setRate(s, { type: 'percentage', percentage: 35 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/brand/affiliates/${s.relationship.id}/commission/history`,
      headers: s.brandAuth.authHeader,
    });

    const events = res.json() as Array<{
      actorId: string;
      previousValue: { percentage: number } | null;
      newValue: { percentage: number } | null;
    }>;
    expect(events).toHaveLength(2);
    // Newest first.
    expect(events[0]!.previousValue?.percentage).toBe(30);
    expect(events[0]!.newValue?.percentage).toBe(35);
    expect(events.every((e) => e.actorId === s.brand.id)).toBe(true);
  });

  it('refuses an override on an affiliate who is not approved', async () => {
    const brand = await makeBrand();
    const affiliate = await makeAffiliate();
    const relationship = await makeRelationship(brand.id, affiliate.id, 'PENDING');
    const auth = await login(app, brand.email);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/brand/affiliates/${relationship.id}/commission`,
      headers: auth.authHeader,
      payload: { commissionStructure: { type: 'percentage', percentage: 50 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ignores an override once the relationship is deactivated', async () => {
    // A negotiated rate was part of an arrangement that has now ended.
    const s = await scenario();
    await setRate(s, { type: 'percentage', percentage: 35 });
    await prisma.brandAffiliate.update({
      where: { id: s.relationship.id },
      data: { status: 'DEACTIVATED' },
    });

    const conv = await sell(s, 'order-deactivated');
    expect(Number(conv.commissionAmount)).toBe(20);
  });

  it('refuses to set a rate on another brand’s affiliate', async () => {
    const s = await scenario();
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/brand/affiliates/${s.relationship.id}/commission`,
      headers: otherAuth.authHeader,
      payload: { commissionStructure: { type: 'percentage', percentage: 99 } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed structure', async () => {
    const s = await scenario();
    const res = await setRate(s, { type: 'percentage', percentage: 150 });
    expect(res.statusCode).toBe(400);
  });

  it('shows the affiliate their own custom rate', async () => {
    const s = await scenario();
    await setRate(s, { type: 'percentage', percentage: 35 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/applications',
      headers: s.affiliateAuth.authHeader,
    });
    const apps = res.json() as Array<{ customCommission: { percentage: number } | null }>;
    // A rate nobody can see is a support ticket waiting to happen.
    expect(apps[0]!.customCommission?.percentage).toBe(35);
  });
});
