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
 * Concurrency and idempotency around payout creation.
 *
 * The bug these exist to prevent: the amount on a payout describing money
 * that is already committed to a different payout. That is not a crash or a
 * 500 -- it is two payouts that each look correct, and an affiliate paid
 * twice for the same work.
 */
describe('payout request safety', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

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
          externalOrderId: `order-${i}-${Math.random().toString(36).slice(2)}`,
          conversionValue: '200.00',
          commissionAmount: each.toFixed(2),
          status: 'APPROVED',
          occurredAt: new Date(),
        },
      });
      await prisma.commission.create({
        data: {
          affiliateId: affiliate.id,
          campaignId: campaign.id,
          conversionId: conversion.id,
          amount: each.toFixed(2),
          status: 'APPROVED',
        },
      });
    }

    const auth = await login(app, affiliate.email);
    return { affiliate, auth };
  }

  it('creates exactly one payout when requests race', async () => {
    const { affiliate, auth } = await affiliateWithBalance();

    // Ten simultaneous requests. Before the advisory lock, several would each
    // create a payout for the full $120, because each read the commissions
    // before any of them claimed them.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/affiliate/payouts',
          headers: auth.authHeader,
          payload: { method: 'manual' },
        })
      )
    );

    const created = responses.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);

    // The rest are refused for a stated reason, not by crashing.
    const rejected = responses.filter((r) => r.statusCode !== 201);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect([400, 409]).toContain(r.statusCode);
    }

    const payouts = await prisma.payout.findMany({
      where: { affiliateId: affiliate.id },
    });
    expect(payouts).toHaveLength(1);
  });

  it('never describes money it does not own', async () => {
    // The invariant. A payout's amount must equal the sum of the commissions
    // actually attached to it -- anything else is money counted twice.
    const { affiliate, auth } = await affiliateWithBalance(4, 25);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/affiliate/payouts',
          headers: auth.authHeader,
          payload: { method: 'manual' },
        })
      )
    );

    const payouts = await prisma.payout.findMany({
      where: { affiliateId: affiliate.id },
      include: { commissions: true },
    });

    for (const p of payouts) {
      const attached = p.commissions.reduce((sum, c) => sum + Number(c.amount), 0);
      expect(Number(p.amount)).toBe(attached);
    }

    // And no commission is attached to more than one payout, which the
    // per-payout check alone would not catch.
    const commissions = await prisma.commission.findMany({
      where: { affiliateId: affiliate.id },
    });
    const payoutIds = commissions.map((c) => c.payoutId).filter(Boolean);
    expect(new Set(payoutIds).size).toBeLessThanOrEqual(1);
  });

  it('refuses a second request while one is in flight', async () => {
    const { auth } = await affiliateWithBalance();

    const first = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'manual' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'manual' },
    });
    expect(second.statusCode).toBe(400);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'PAYOUT_IN_FLIGHT'
    );
  });

  it('returns the original payout when a request is replayed with the same key', async () => {
    const { auth } = await affiliateWithBalance();
    const headers = { ...auth.authHeader, 'idempotency-key': 'retry-abc-123' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers,
      payload: { method: 'manual' },
    });
    expect(first.statusCode).toBe(201);

    // A client that timed out and retried must not create a second payout,
    // and must not be told it already has one in flight -- it wants its
    // original result.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers,
      payload: { method: 'manual' },
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id
    );

    expect(await prisma.payout.count()).toBe(1);
  });

  it('lets two different affiliates request at the same time', async () => {
    // The lock is per affiliate, not global. One busy affiliate must not
    // block everyone else's payouts.
    const one = await affiliateWithBalance();
    const two = await affiliateWithBalance();

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/affiliate/payouts',
        headers: one.auth.authHeader,
        payload: { method: 'manual' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/affiliate/payouts',
        headers: two.auth.authHeader,
        payload: { method: 'manual' },
      }),
    ]);

    expect(a!.statusCode).toBe(201);
    expect(b!.statusCode).toBe(201);
  });

  it('still enforces the minimum payout', async () => {
    const { auth } = await affiliateWithBalance(1, 10); // $10, minimum is $50

    const res = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'manual' },
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.payout.count()).toBe(0);
  });

  it('records who requested the payout', async () => {
    const { affiliate, auth } = await affiliateWithBalance();
    const res = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'manual' },
    });

    const events = await prisma.payoutEvent.findMany({
      where: { payoutId: (res.json() as { id: string }).id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(affiliate.id);
  });
});
