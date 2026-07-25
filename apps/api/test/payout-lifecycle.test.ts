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
 * The payout lifecycle.
 *
 * These assertions are mostly about the *commissions*, not the payout row.
 * A payout marked PAID whose commissions are still INCLUDED_IN_PAYOUT looks
 * fine on the admin screen and is wrong everywhere the affiliate looks, so
 * checking the payout's own status proves very little on its own.
 */
describe('payout lifecycle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** An affiliate with `count` approved commissions of `each` dollars. */
  async function affiliateWithBalance(count = 3, each = 40) {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    for (let i = 0; i < count; i++) {
      const conversion = await prisma.conversion.create({
        data: {
          trackingLinkId: link.id,
          campaignId: campaign.id,
          affiliateId: affiliate.id,
          externalOrderId: `order-${i}-${Date.now()}`,
          conversionValue: '200.00',
          commissionAmount: each.toFixed(2),
          status: 'APPROVED',
          occurredAt: new Date(),
          approvedAt: new Date(),
        },
      });
      await prisma.commission.create({
        data: {
          affiliateId: affiliate.id,
          campaignId: campaign.id,
          conversionId: conversion.id,
          amount: each.toFixed(2),
          status: 'APPROVED',
          approvedAt: new Date(),
        },
      });
    }

    const affiliateAuth = await login(app, affiliate.email);
    const admin = await makeAdmin();
    const adminAuth = await login(app, admin.email);
    return { affiliate, affiliateAuth, admin, adminAuth };
  }

  async function requestPayout(auth: { authHeader: Record<string, string> }) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'manual' },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; amount: string; netAmount: string };
  }

  it('carries a payout from request through to paid commissions', async () => {
    const { affiliate, affiliateAuth, admin, adminAuth } = await affiliateWithBalance();

    const payout = await requestPayout(affiliateAuth);
    // 3 x $40 gross, 5% platform fee.
    expect(payout.amount).toBe('120.00');
    expect(payout.netAmount).toBe('114.00');

    // Requesting moves the commissions out of "approved" but not into "paid".
    const summaryAfterRequest = await app.inject({
      method: 'GET',
      url: '/api/affiliate/earnings/summary',
      headers: affiliateAuth.authHeader,
    });
    expect(summaryAfterRequest.json()).toMatchObject({
      approved: '0.00',
      inPayout: '120.00',
      paid: '0.00',
    });

    await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/process`,
      headers: adminAuth.authHeader,
    });

    const completed = await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/complete`,
      headers: adminAuth.authHeader,
      payload: { reference: 'bank-ref-123' },
    });
    expect(completed.statusCode).toBe(200);

    // The assertion that matters: the commissions themselves are PAID.
    const commissions = await prisma.commission.findMany({
      where: { payoutId: payout.id },
    });
    expect(commissions).toHaveLength(3);
    expect(commissions.every((c) => c.status === 'PAID')).toBe(true);
    expect(commissions.every((c) => c.paidAt !== null)).toBe(true);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/affiliate/earnings/summary',
      headers: affiliateAuth.authHeader,
    });
    // "Paid lifetime" was structurally always $0.00 before this story.
    expect(summary.json()).toMatchObject({ inPayout: '0.00', paid: '120.00' });

    const history = await app.inject({
      method: 'GET',
      url: `/api/admin/payouts/${payout.id}/history`,
      headers: adminAuth.authHeader,
    });
    const events = history.json() as Array<{
      fromStatus: string;
      toStatus: string;
      actorId: string;
    }>;
    expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
      'PENDING->PROCESSING',
      'PROCESSING->PAID',
    ]);
    expect(events.every((e) => e.actorId === admin.id)).toBe(true);
    expect(affiliate.id).toBeTruthy();
  });

  it('returns commissions to the balance when a payout fails', async () => {
    const { affiliateAuth, adminAuth } = await affiliateWithBalance();
    const payout = await requestPayout(affiliateAuth);

    const failed = await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/fail`,
      headers: adminAuth.authHeader,
      payload: { reason: 'Bank rejected the transfer' },
    });
    expect(failed.statusCode).toBe(200);

    // The money never left, so the work is owed again and must become
    // available for a later payout rather than vanishing.
    const commissions = await prisma.commission.findMany({
      where: { affiliateId: (await prisma.payout.findUniqueOrThrow({
        where: { id: payout.id },
      })).affiliateId },
    });
    expect(commissions.every((c) => c.status === 'APPROVED')).toBe(true);
    expect(commissions.every((c) => c.payoutId === null)).toBe(true);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/affiliate/earnings/summary',
      headers: affiliateAuth.authHeader,
    });
    expect(summary.json()).toMatchObject({ approved: '120.00', inPayout: '0.00' });

    // And they can be requested again.
    const second = await requestPayout(affiliateAuth);
    expect(second.amount).toBe('120.00');
  });

  it('requires a reason when failing a payout', async () => {
    const { affiliateAuth, adminAuth } = await affiliateWithBalance();
    const payout = await requestPayout(affiliateAuth);

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/fail`,
      headers: adminAuth.authHeader,
      payload: {},
    });
    // An unexplained failure is unactionable for whoever picks it up next.
    expect(res.statusCode).toBe(400);
  });

  it('refuses illegal transitions with a machine-readable code', async () => {
    const { affiliateAuth, adminAuth } = await affiliateWithBalance();
    const payout = await requestPayout(affiliateAuth);

    // PENDING straight to PAID would skip the record that someone actually
    // initiated the transfer.
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/complete`,
      headers: adminAuth.authHeader,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_TRANSITION'
    );
  });

  it('treats a paid payout as terminal', async () => {
    const { affiliateAuth, adminAuth } = await affiliateWithBalance();
    const payout = await requestPayout(affiliateAuth);

    await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/process`,
      headers: adminAuth.authHeader,
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/complete`,
      headers: adminAuth.authHeader,
      payload: {},
    });

    for (const action of ['process', 'cancel']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/payouts/${payout.id}/${action}`,
        headers: adminAuth.authHeader,
        payload: {},
      });
      expect(res.statusCode, action).toBe(400);
    }
  });

  it('lets a failed payout be retried without re-requesting it', async () => {
    const { affiliateAuth, adminAuth } = await affiliateWithBalance();
    const payout = await requestPayout(affiliateAuth);

    await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/process`,
      headers: adminAuth.authHeader,
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/fail`,
      headers: adminAuth.authHeader,
      payload: { reason: 'Wrong account number' },
    });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/admin/payouts/${payout.id}/process`,
      headers: adminAuth.authHeader,
    });
    expect(retry.statusCode).toBe(200);
  });

  it('shows an affiliate only their own payouts', async () => {
    const one = await affiliateWithBalance();
    const two = await affiliateWithBalance();
    await requestPayout(one.affiliateAuth);
    await requestPayout(two.affiliateAuth);

    const res = await app.inject({
      method: 'GET',
      url: '/api/affiliate/payouts',
      headers: one.affiliateAuth.authHeader,
    });
    const body = res.json() as { items: Array<{ affiliateId: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.affiliateId).toBe(one.affiliate.id);
  });

  it('keeps the admin queue away from non-admins', async () => {
    const { affiliateAuth } = await affiliateWithBalance();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/payouts',
      headers: affiliateAuth.authHeader,
    });
    expect(res.statusCode).toBe(403);
  });
});
