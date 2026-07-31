import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeApiKey,
  makeBrand,
  makeCampaign,
  makeClickEvent,
  makeRelationship,
  makeTrackingLink,
  postbackHeaders,
} from './factories';

describe('fraud scoring and review', () => {
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
    const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);
    return { brand, campaign, affiliate, link, key };
  }

  async function report(
    campaignId: string,
    payload: Record<string, unknown>,
    key: { keyId: string; secret: string }
  ) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: `/api/conversions/${campaignId}`,
      headers: postbackHeaders(key.keyId, key.secret, body),
      payload: body,
    });
  }

  it('flags a conversion that lands seconds after the click', async () => {
    // A human does not click an ad and complete a checkout in under five
    // seconds. This is either a bot or a stuffed cookie.
    const s = await scenario();
    const cookie = 'fast-cookie';
    await makeClickEvent(s.link.id, { cookieId: cookie, timestamp: new Date() });

    await report(
      s.campaign.id,
      { externalOrderId: 'fast-1', conversionValue: 100, attributionCookieId: cookie },
      s.key
    );

    const review = await prisma.fraudReview.findFirstOrThrow();
    expect(review.riskScore).toBeGreaterThanOrEqual(40);
    expect(review.decision).toBe('PENDING');

    const signals = review.signals as Array<{ rule: string }>;
    expect(signals.map((x) => x.rule)).toContain('low_latency');
  });

  it('does not open a review when nothing is suspicious', async () => {
    const s = await scenario();
    const cookie = 'normal-cookie';
    // Two hours between click and purchase is ordinary shopping behaviour.
    await makeClickEvent(s.link.id, {
      cookieId: cookie,
      timestamp: new Date(Date.now() - 2 * 3600 * 1000),
    });

    await report(
      s.campaign.id,
      { externalOrderId: 'normal-1', conversionValue: 100, attributionCookieId: cookie },
      s.key
    );

    expect(await prisma.fraudReview.count()).toBe(0);
  });

  it('claws back the commission when an admin blocks a conversion', async () => {
    const s = await scenario();
    const cookie = 'blocked-cookie';
    await makeClickEvent(s.link.id, { cookieId: cookie, timestamp: new Date() });

    await report(
      s.campaign.id,
      { externalOrderId: 'blocked-1', conversionValue: 100, attributionCookieId: cookie },
      s.key
    );

    const review = await prisma.fraudReview.findFirstOrThrow();
    const admin = await makeAdmin();
    const adminAuth = await login(app, admin.email);

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/fraud-reviews/${review.id}/decide`,
      headers: adminAuth.authHeader,
      payload: { decision: 'BLOCKED', notes: 'Bot traffic' },
    });
    expect(res.statusCode).toBe(200);

    const conversion = await prisma.conversion.findFirstOrThrow({
      where: { id: review.conversionId },
    });
    expect(conversion.status).toBe('REJECTED');

    const commission = await prisma.commission.findFirstOrThrow({
      where: { conversionId: review.conversionId },
    });
    expect(commission.status).toBe('CLAWED_BACK');
  });

  it('still flags a one-IP cookie when the campaign has other traffic', async () => {
    // The scoping bug. The click count was per-cookie but the distinct-IP
    // count was taken across the whole affiliate/campaign, so the rule read
    // "this cookie clicked a lot AND the campaign has only ever seen one IP".
    // Two ordinary visitors were enough to switch the signal off for good --
    // on exactly the busy campaigns worth policing.
    const s = await scenario();
    const suspect = 'suspect-cookie';

    // Six clicks, one IP, one cookie: this is what the rule exists to catch.
    for (let i = 0; i < 6; i++) {
      await prisma.clickEvent.create({
        data: {
          trackingLinkId: s.link.id,
          timestamp: new Date(Date.now() - 60 * 1000),
          ipHash: 'same-ip',
          userAgent: 'Mozilla/5.0 (test)',
          attributionCookieId: suspect,
        },
      });
    }

    // Unrelated, perfectly normal traffic on the same campaign from other IPs.
    for (const ip of ['ip-a', 'ip-b', 'ip-c']) {
      await prisma.clickEvent.create({
        data: {
          trackingLinkId: s.link.id,
          timestamp: new Date(Date.now() - 60 * 1000),
          ipHash: ip,
          userAgent: 'Mozilla/5.0 (test)',
          attributionCookieId: `normal-${ip}`,
        },
      });
    }

    await report(
      s.campaign.id,
      {
        externalOrderId: 'concentrated-1',
        conversionValue: 100,
        attributionCookieId: suspect,
      },
      s.key
    );

    const review = await prisma.fraudReview.findFirstOrThrow();
    const rules = (review.signals as Array<{ rule: string }>).map((x) => x.rule);
    expect(rules).toContain('cookie_ip_concentration');
  });

  it('does not flag concentration for a cookie using several IPs', async () => {
    const s = await scenario();
    const cookie = 'spread-cookie';

    for (const ip of ['ip-1', 'ip-2', 'ip-3', 'ip-4', 'ip-5', 'ip-6']) {
      await prisma.clickEvent.create({
        data: {
          trackingLinkId: s.link.id,
          timestamp: new Date(Date.now() - 60 * 1000),
          ipHash: ip,
          userAgent: 'Mozilla/5.0 (test)',
          attributionCookieId: cookie,
        },
      });
    }

    await report(
      s.campaign.id,
      { externalOrderId: 'spread-1', conversionValue: 100, attributionCookieId: cookie },
      s.key
    );

    const review = await prisma.fraudReview.findFirst();
    const rules = ((review?.signals ?? []) as Array<{ rule: string }>).map((x) => x.rule);
    expect(rules).not.toContain('cookie_ip_concentration');
  });

  it('records the reviewing admin', async () => {
    const s = await scenario();
    const cookie = 'audit-cookie';
    await makeClickEvent(s.link.id, { cookieId: cookie, timestamp: new Date() });
    await report(
      s.campaign.id,
      { externalOrderId: 'audit-1', conversionValue: 100, attributionCookieId: cookie },
      s.key
    );

    const review = await prisma.fraudReview.findFirstOrThrow();
    const admin = await makeAdmin();
    const adminAuth = await login(app, admin.email);

    await app.inject({
      method: 'POST',
      url: `/api/admin/fraud-reviews/${review.id}/decide`,
      headers: adminAuth.authHeader,
      payload: { decision: 'CLEARED' },
    });

    const after = await prisma.fraudReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.reviewerId).toBe(admin.id);
    expect(after.decidedAt).not.toBeNull();
  });
});
