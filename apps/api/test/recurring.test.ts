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

describe('recurring commissions', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function scenario(recurringMonths = 3) {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, {
      lockPeriodDays: 0,
      commissionStructure: {
        type: 'recurring',
        percentage: 30,
        recurringMonths,
      },
    });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);
    return { brand, campaign, affiliate, link, key };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  async function firstSale(s: Scenario, orderId = 'sub-1', amount = 100) {
    const cookie = `cookie-${orderId}`;
    await makeClickEvent(s.link.id, {
      cookieId: cookie,
      timestamp: new Date(Date.now() - 3600 * 1000),
    });
    const body = JSON.stringify({
      externalOrderId: orderId,
      conversionValue: amount,
      attributionCookieId: cookie,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return orderId;
  }

  function renew(s: Scenario, reference: string, amount = 100) {
    const body = JSON.stringify({ externalReference: reference, amount });
    return app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}/recurring`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });
  }

  it('starts a subscription on the first sale', async () => {
    const s = await scenario(12);
    await firstSale(s);

    const sub = await prisma.subscription.findFirstOrThrow();
    expect(sub.totalPeriods).toBe(12);
    // The first sale is period one; it already produced a commission.
    expect(sub.completedPeriods).toBe(1);
    expect(sub.status).toBe('ACTIVE');
  });

  it('pays a commission for each period of the term and then stops', async () => {
    // The whole point: "30% for 3 months" should pay three times, not once.
    const s = await scenario(3);
    await firstSale(s);

    expect((await renew(s, 'sub-1')).statusCode).toBe(200);
    expect((await renew(s, 'sub-1')).statusCode).toBe(200);

    // The fourth event is past the term.
    const fourth = await renew(s, 'sub-1');
    expect(fourth.json()).toEqual({ skipped: 'term_complete' });

    const commissions = await prisma.commission.findMany();
    expect(commissions).toHaveLength(3);
    expect(commissions.every((c) => Number(c.amount) === 30)).toBe(true);

    const sub = await prisma.subscription.findFirstOrThrow();
    expect(sub.status).toBe('COMPLETED');
  });

  it('accepts events past the term without erroring', async () => {
    // A brand's billing system should not have to mirror our counter to know
    // whether to send an event. Making them track our state is how the two
    // drift apart.
    const s = await scenario(1);
    await firstSale(s);

    const res = await renew(s, 'sub-1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: 'term_complete' });
  });

  it('keeps the original terms when the campaign rate changes', async () => {
    const s = await scenario(6);
    await firstSale(s);

    // The brand halves the rate mid-term.
    await prisma.campaign.update({
      where: { id: s.campaign.id },
      data: {
        commissionStructure: { type: 'recurring', percentage: 15, recurringMonths: 6 },
      },
    });

    await renew(s, 'sub-1');

    const conversions = await prisma.conversion.findMany({
      orderBy: { createdAt: 'asc' },
    });
    // A customer who signed up under a 30% deal keeps it. Otherwise a brand
    // could retroactively cut a rate they already promised.
    expect(Number(conversions[1]!.commissionAmount)).toBe(30);
  });

  it('skips attribution entirely for renewals', async () => {
    // Which affiliate earned this customer was settled by the first sale.
    // Re-running attribution months later would find no click and credit
    // nobody, silently ending the affiliate's income.
    const s = await scenario(6);
    await firstSale(s);
    await prisma.clickEvent.deleteMany({});

    const res = await renew(s, 'sub-1');
    expect(res.statusCode).toBe(200);

    const conversions = await prisma.conversion.findMany();
    expect(conversions).toHaveLength(2);
    expect(conversions.every((c) => c.affiliateId === s.affiliate.id)).toBe(true);
  });

  it('marks renewals as returning customers', async () => {
    const s = await scenario(6);
    await firstSale(s);
    await renew(s, 'sub-1');

    const renewal = await prisma.conversion.findFirstOrThrow({
      where: { externalOrderId: 'sub-1:m2' },
    });
    expect(renewal.isFirstTimeCustomer).toBe(false);
  });

  it('refuses a duplicate billing period', async () => {
    const s = await scenario(6);
    await firstSale(s);
    expect((await renew(s, 'sub-1')).statusCode).toBe(200);

    // Simulate a webhook retry landing after the first succeeded by forcing
    // the counter back; the order id guard is what must stop the double pay.
    await prisma.subscription.updateMany({ data: { completedPeriods: 1 } });
    const retry = await renew(s, 'sub-1');
    expect(retry.statusCode).toBe(409);
  });

  it('stops future commissions when cancelled but keeps earned ones', async () => {
    const s = await scenario(12);
    await firstSale(s);
    await renew(s, 'sub-1');

    const body = JSON.stringify({ externalReference: 'sub-1' });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}/recurring/cancel`,
      headers: postbackHeaders(s.key.keyId, s.key.secret, body),
      payload: body,
    });
    expect(cancel.statusCode).toBe(200);

    const after = await renew(s, 'sub-1');
    expect(after.json()).toEqual({ skipped: 'cancelled' });

    // Two periods were earned before the cancellation and they stay earned.
    expect(await prisma.commission.count()).toBe(2);
  });

  it('requires a signature on renewals', async () => {
    const s = await scenario();
    await firstSale(s);

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversions/${s.campaign.id}/recurring`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ externalReference: 'sub-1', amount: 100 }),
    });
    // Renewals create commissions, so they need the same authentication as a
    // first sale.
    expect(res.statusCode).toBe(401);
  });

  it('404s for an unknown subscription', async () => {
    const s = await scenario();
    const res = await renew(s, 'no-such-reference');
    expect(res.statusCode).toBe(404);
  });

  it('does not create a subscription for a non-recurring campaign', async () => {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 }); // percentage
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);

    await firstSale({ brand, campaign, affiliate, link, key } as Scenario, 'plain-1');

    expect(await prisma.subscription.count()).toBe(0);
  });
});
