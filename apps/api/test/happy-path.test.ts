import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { drainClickEvents } from '../src/workers/click-event.worker';
import { promoteExpiredLocks } from '../src/workers/lock-expiry.worker';
import {
  login,
  makeAffiliate,
  makeApiKey,
  makeBrand,
  makeCampaign,
  makeRelationship,
  postbackHeaders,
  TEST_PASSWORD,
} from './factories';

/**
 * The whole business, once, in order.
 *
 * If this suite passes, money can get from a shopper's click to an affiliate's
 * payout. Every other integration suite tests a way that can go wrong; this
 * one tests that it can go right at all.
 */
describe('end to end: click to payout', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes a click all the way through to an approved commission', async () => {
    // --- a brand with a live campaign -----------------------------------
    const brand = await makeBrand();
    // A real 30-day hold. We do not wait for it -- `promoteExpiredLocks` takes
    // the clock as an argument, so the test can ask "what happens 31 days from
    // now?" directly. Setting the period to 0 instead would skip the worker
    // entirely: conversionService.review promotes any commission whose lock has
    // already expired, so a zero-day hold never reaches the worker at all.
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 30 });

    // --- an approved affiliate ------------------------------------------
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id, 'APPROVED');
    const affiliateAuth = await login(app, affiliate.email);

    // --- who creates a tracking link through the API --------------------
    const linkRes = await app.inject({
      method: 'POST',
      url: '/api/affiliate/links',
      headers: affiliateAuth.authHeader,
      payload: {
        campaignId: campaign.id,
        destinationUrl: 'https://acme.example.com/pricing',
      },
    });
    expect(linkRes.statusCode).toBe(201);
    const link = linkRes.json() as { id: string; shortCode: string };

    // --- a shopper clicks -----------------------------------------------
    // The redirect service is a separate deployable, so here we push the same
    // payload it would push and then run the worker that drains it.
    const cookieId = 'cookie-happy-path';
    await redis.lpush(
      'click_events',
      JSON.stringify({
        trackingLinkId: link.id,
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        cookieId,
        timestamp: Date.now(),
        ip: 'hashed-ip',
        userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120',
        referrer: '',
        subIds: {},
      })
    );

    const { flushed } = await drainClickEvents();
    expect(flushed).toBe(1);

    const clicks = await prisma.clickEvent.findMany({
      where: { trackingLinkId: link.id },
    });
    expect(clicks).toHaveLength(1);
    // The worker parses the user agent on the way in.
    expect(clicks[0]!.browser).toBe('Chrome');

    // Denormalised counters are updated by the worker, not in real time.
    const afterClick = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(afterClick.clickCount).toBe(1);

    // --- the shopper buys, and the storefront reports it ----------------
    const { keyId, secret } = await makeApiKey(campaign.id);
    const body = JSON.stringify({
      externalOrderId: 'order-1',
      conversionValue: 150,
      attributionCookieId: cookieId,
    });

    const convRes = await app.inject({
      method: 'POST',
      url: `/api/conversions/${campaign.id}`,
      headers: postbackHeaders(keyId, secret, body),
      payload: body,
    });
    expect(convRes.statusCode).toBe(201);

    const conversion = await prisma.conversion.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    expect(conversion.status).toBe('PENDING');
    // 20% of 150.
    expect(Number(conversion.commissionAmount)).toBe(30);

    const commission = await prisma.commission.findFirstOrThrow({
      where: { conversionId: conversion.id },
    });
    // Created LOCKED, never PENDING -- see the note in the overview doc.
    expect(commission.status).toBe('LOCKED');

    // --- the brand approves it ------------------------------------------
    const brandAuth = await login(app, brand.email);
    const reviewRes = await app.inject({
      method: 'POST',
      url: `/api/brand/conversions/${conversion.id}/review`,
      headers: brandAuth.authHeader,
      payload: { status: 'approved' },
    });
    expect(reviewRes.statusCode).toBe(200);

    // Approval alone does not release the money: the hold is what protects
    // the brand against a refund arriving after the payout.
    const stillLocked = await prisma.commission.findUniqueOrThrow({
      where: { id: commission.id },
    });
    expect(stillLocked.status).toBe('LOCKED');

    // Nothing to promote yet, 30 days early.
    expect((await promoteExpiredLocks(new Date())).promoted).toBe(0);

    // --- the lock expires ------------------------------------------------
    const thirtyOneDays = new Date(Date.now() + 31 * 86400 * 1000);
    const { promoted } = await promoteExpiredLocks(thirtyOneDays);
    expect(promoted).toBe(1);

    const approved = await prisma.commission.findUniqueOrThrow({
      where: { id: commission.id },
    });
    expect(approved.status).toBe('APPROVED');

    // --- and the affiliate can see the money ----------------------------
    const summaryRes = await app.inject({
      method: 'GET',
      url: '/api/affiliate/earnings/summary',
      headers: affiliateAuth.authHeader,
    });
    expect(summaryRes.json()).toMatchObject({ approved: '30.00' });
  });

  it('does not promote a commission whose conversion is still unreviewed', async () => {
    // The lock expiring is necessary but not sufficient: the brand still owes
    // a decision, and paying out before they make it would be paying for a
    // sale nobody confirmed.
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);

    const conversion = await prisma.conversion.create({
      data: {
        trackingLinkId: (
          await prisma.trackingLink.create({
            data: {
              affiliateId: affiliate.id,
              campaignId: campaign.id,
              shortCode: `unrev${Date.now().toString(36)}`,
              destinationUrl: 'https://acme.example.com',
            },
          })
        ).id,
        campaignId: campaign.id,
        affiliateId: affiliate.id,
        externalOrderId: 'order-unreviewed',
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

    const { promoted } = await promoteExpiredLocks(new Date());
    expect(promoted).toBe(0);
  });

  it('registers, logs in, and revokes sessions on logout', async () => {
    const email = `newbie-${Date.now()}@example.com`;

    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        password: TEST_PASSWORD,
        firstName: 'New',
        lastName: 'Bie',
        role: 'AFFILIATE',
      },
    });
    expect(registerRes.statusCode).toBe(200);
    const { accessToken } = registerRes.json() as { accessToken: string };
    const auth = { authorization: `Bearer ${accessToken}` };

    const meRes = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth });
    expect(meRes.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth });

    // The token that worked a moment ago is dead.
    //
    // The assertion is unchanged, but the mechanism behind it is not: logout
    // used to bump tokenVersion, which ended *every* session the user had.
    // It now revokes only this session's token family, and requireAuth checks
    // that family -- so logging out is still immediate without signing the
    // user out of their other devices. `logout-all` is what bumps
    // tokenVersion now.
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth,
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
