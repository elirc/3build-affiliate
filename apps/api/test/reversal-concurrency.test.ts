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
 * Concurrency around reversing and reviewing a conversion.
 *
 * Both paths used to read their preconditions *outside* the transaction and
 * then write by id inside it, which is the same check-then-act shape that let
 * concurrent payout requests double-pay. It was fixed for payouts and not for
 * these, which is why the tests exist now rather than an argument that it
 * cannot happen.
 */
describe('conversion reversal and review concurrency', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function approvedSale(
    commissionStatus: 'APPROVED' | 'PAID' = 'PAID',
    value = 100,
    commissionAmount = 20
  ) {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    const conversion = await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: campaign.id,
        affiliateId: affiliate.id,
        externalOrderId: `order-${Math.random().toString(36).slice(2)}`,
        conversionValue: value.toFixed(2),
        commissionAmount: commissionAmount.toFixed(2),
        status: 'APPROVED',
        approvedAt: new Date(),
        occurredAt: new Date(),
      },
    });

    await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        conversionId: conversion.id,
        amount: commissionAmount.toFixed(2),
        status: commissionStatus,
        ...(commissionStatus === 'PAID' ? { paidAt: new Date() } : {}),
      },
    });

    return { brand, affiliate, conversion, brandAuth: await login(app, brand.email) };
  }

  function reverse(
    auth: { authHeader: Record<string, string> },
    conversionId: string,
    body: object
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/brand/conversions/${conversionId}/reverse`,
      headers: auth.authHeader,
      payload: body,
    });
  }

  it('claws back a paid commission exactly once under concurrent requests', async () => {
    // The monetary-integrity bug: both requests read the conversion as
    // APPROVED and the commission as PAID, then each wrote its own negative
    // balance adjustment. The same refund came out of the affiliate's next
    // payout twice.
    const s = await approvedSale('PAID', 100, 20);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        reverse(s.brandAuth, s.conversion.id, { reason: 'Chargeback' })
      )
    );

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);

    const adjustments = await prisma.balanceAdjustment.findMany({
      where: { affiliateId: s.affiliate.id },
    });
    expect(adjustments).toHaveLength(1);
    expect(Number(adjustments[0]!.amount)).toBe(-20);
  });

  it('does not reduce a partial refund twice', async () => {
    // A conditional claim on status would not have caught this: a partial
    // refund leaves the conversion APPROVED, so the "still APPROVED?" test
    // passes for the second request too. Only the lock stops it.
    const s = await approvedSale('APPROVED', 100, 20);

    await Promise.all(
      Array.from({ length: 4 }, () =>
        reverse(s.brandAuth, s.conversion.id, { reason: 'Partial', refundAmount: 50 })
      )
    );

    const conversion = await prisma.conversion.findUniqueOrThrow({
      where: { id: s.conversion.id },
    });
    // Exactly one reduction: half of 100 and half of 20.
    expect(Number(conversion.conversionValue)).toBe(50);
    expect(Number(conversion.commissionAmount)).toBe(10);
  });

  it('emits exactly one clawback notification', async () => {
    const s = await approvedSale('PAID');

    await Promise.all(
      Array.from({ length: 4 }, () =>
        reverse(s.brandAuth, s.conversion.id, { reason: 'Chargeback' })
      )
    );

    const notifications = await prisma.notification.findMany({
      where: { type: 'commission_clawed_back' },
    });
    expect(notifications).toHaveLength(1);
  });

  it('lets exactly one of a simultaneous approve and reject win', async () => {
    // A double-clicked review, or an approve and a reject arriving together,
    // both passed the PENDING check and both wrote -- racing on the final
    // state and sending the affiliate two contradictory notifications.
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    const conversion = await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: campaign.id,
        affiliateId: affiliate.id,
        externalOrderId: 'race-1',
        conversionValue: '100.00',
        commissionAmount: '20.00',
        status: 'PENDING',
        occurredAt: new Date(),
      },
    });
    await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        conversionId: conversion.id,
        amount: '20.00',
        status: 'LOCKED',
        lockExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const auth = await login(app, brand.email);
    const review = (status: 'approved' | 'rejected') =>
      app.inject({
        method: 'POST',
        url: `/api/brand/conversions/${conversion.id}/review`,
        headers: auth.authHeader,
        payload: { status, reason: 'race' },
      });

    const responses = await Promise.all([
      review('approved'),
      review('rejected'),
      review('approved'),
    ]);

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);

    // And the affiliate is told once, not three times and not contradictorily.
    const notifications = await prisma.notification.findMany({
      where: { userId: affiliate.id },
    });
    expect(notifications).toHaveLength(1);
  });

  it('still refuses a second reversal after the first has settled', async () => {
    // Sequential, not concurrent -- the ordinary case must keep working.
    const s = await approvedSale('APPROVED');

    expect((await reverse(s.brandAuth, s.conversion.id, { reason: 'One' })).statusCode)
      .toBe(200);
    expect((await reverse(s.brandAuth, s.conversion.id, { reason: 'Two' })).statusCode)
      .toBe(400);
  });
});
