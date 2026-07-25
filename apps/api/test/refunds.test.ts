import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * Refunds and clawbacks.
 *
 * The outcome depends entirely on how far the commission has travelled, and
 * the last case is the one that cannot be expressed as a status change: money
 * that has already been paid has to be recovered from a future payout.
 */
describe('reversing an approved conversion', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function approvedSale(
    commissionStatus: 'LOCKED' | 'APPROVED' | 'INCLUDED_IN_PAYOUT' | 'PAID' = 'APPROVED',
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

    const commission = await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        conversionId: conversion.id,
        amount: commissionAmount.toFixed(2),
        status: commissionStatus,
        ...(commissionStatus === 'PAID' ? { paidAt: new Date() } : {}),
      },
    });

    const brandAuth = await login(app, brand.email);
    const affiliateAuth = await login(app, affiliate.email);
    return { brand, brandAuth, affiliate, affiliateAuth, conversion, commission, link };
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

  it('claws back a locked commission on a full refund', async () => {
    const s = await approvedSale('LOCKED');

    const res = await reverse(s.brandAuth, s.conversion.id, {
      reason: 'Customer returned the item',
    });
    expect(res.statusCode).toBe(200);

    const commission = await prisma.commission.findUniqueOrThrow({
      where: { id: s.commission.id },
    });
    expect(commission.status).toBe('CLAWED_BACK');

    const conversion = await prisma.conversion.findUniqueOrThrow({
      where: { id: s.conversion.id },
    });
    expect(conversion.status).toBe('REJECTED');
    expect(conversion.rejectionReason).toBe('Customer returned the item');
  });

  it('reduces the commission proportionally on a partial refund', async () => {
    const s = await approvedSale('APPROVED', 100, 20);

    const res = await reverse(s.brandAuth, s.conversion.id, {
      reason: 'Partial return',
      refundAmount: 50,
    });
    expect(res.statusCode).toBe(200);

    const conversion = await prisma.conversion.findUniqueOrThrow({
      where: { id: s.conversion.id },
    });
    // A partial refund is still a real sale, so the conversion stays approved
    // with reduced figures rather than vanishing from the affiliate's history.
    expect(conversion.status).toBe('APPROVED');
    expect(Number(conversion.conversionValue)).toBe(50);
    expect(Number(conversion.commissionAmount)).toBe(10);

    const commission = await prisma.commission.findUniqueOrThrow({
      where: { id: s.commission.id },
    });
    expect(commission.status).toBe('APPROVED');
    expect(Number(commission.amount)).toBe(10);
  });

  it('creates a negative balance adjustment when the commission is already paid', async () => {
    // The case that cannot be a status change: the money has left.
    const s = await approvedSale('PAID', 100, 20);

    const res = await reverse(s.brandAuth, s.conversion.id, {
      reason: 'Chargeback',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { clawbackMethod: string }).clawbackMethod).toBe(
      'balance_adjustment'
    );

    const adjustment = await prisma.balanceAdjustment.findFirstOrThrow({
      where: { affiliateId: s.affiliate.id },
    });
    expect(Number(adjustment.amount)).toBe(-20);
    expect(adjustment.settledPayoutId).toBeNull();

    // The paid commission is left alone -- rewriting history to say it was
    // never paid would make the payout that paid it inexplicable.
    const commission = await prisma.commission.findUniqueOrThrow({
      where: { id: s.commission.id },
    });
    expect(commission.status).toBe('PAID');
  });

  it('nets a pending clawback off the next payout', async () => {
    const s = await approvedSale('PAID', 100, 20);
    await reverse(s.brandAuth, s.conversion.id, { reason: 'Chargeback' });

    // Give the affiliate fresh earnings to be paid.
    for (let i = 0; i < 2; i++) {
      const conversion = await prisma.conversion.create({
        data: {
          trackingLinkId: s.link.id,
          campaignId: s.conversion.campaignId,
          affiliateId: s.affiliate.id,
          externalOrderId: `new-${i}-${Math.random().toString(36).slice(2)}`,
          conversionValue: '200.00',
          commissionAmount: '40.00',
          status: 'APPROVED',
          occurredAt: new Date(),
        },
      });
      await prisma.commission.create({
        data: {
          affiliateId: s.affiliate.id,
          campaignId: s.conversion.campaignId,
          conversionId: conversion.id,
          amount: '40.00',
          status: 'APPROVED',
        },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: s.affiliateAuth.authHeader,
      payload: { method: 'manual' },
    });
    expect(res.statusCode).toBe(201);

    // $80 earned minus the $20 clawback.
    expect((res.json() as { amount: string }).amount).toBe('60.00');

    // And it is marked settled, so it is not deducted again next time.
    const adjustment = await prisma.balanceAdjustment.findFirstOrThrow({
      where: { affiliateId: s.affiliate.id },
    });
    expect(adjustment.settledPayoutId).toBe((res.json() as { id: string }).id);
  });

  it('refuses to reverse a commission committed to an unsettled payout', async () => {
    const s = await approvedSale('INCLUDED_IN_PAYOUT');

    const res = await reverse(s.brandAuth, s.conversion.id, { reason: 'Refund' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'COMMISSION_IN_PAYOUT'
    );
  });

  it('is idempotent: a second reversal changes nothing', async () => {
    const s = await approvedSale('APPROVED');
    await reverse(s.brandAuth, s.conversion.id, { reason: 'Refund' });

    const second = await reverse(s.brandAuth, s.conversion.id, { reason: 'Refund' });
    expect(second.statusCode).toBe(400);

    expect(
      await prisma.commission.count({ where: { status: 'CLAWED_BACK' } })
    ).toBe(1);
  });

  it('requires a reason', async () => {
    const s = await approvedSale('APPROVED');
    const res = await reverse(s.brandAuth, s.conversion.id, {});
    expect(res.statusCode).toBe(400);
  });

  it('rejects a refund larger than the order', async () => {
    const s = await approvedSale('APPROVED', 100, 20);
    const res = await reverse(s.brandAuth, s.conversion.id, {
      reason: 'Oops',
      refundAmount: 500,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses another brand’s conversion', async () => {
    const s = await approvedSale('APPROVED');
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    const res = await reverse(otherAuth, s.conversion.id, { reason: 'Not mine' });
    expect(res.statusCode).toBe(403);
  });

  it('decrements the denormalised counters', async () => {
    const s = await approvedSale('APPROVED', 100, 20);
    await prisma.trackingLink.update({
      where: { id: s.link.id },
      data: { conversionCount: 1, revenue: '100.00' },
    });

    await reverse(s.brandAuth, s.conversion.id, { reason: 'Refund' });

    const link = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: s.link.id },
    });
    expect(link.conversionCount).toBe(0);
    expect(Number(link.revenue)).toBe(0);
    expect(await makeAdmin()).toBeTruthy();
  });
});
