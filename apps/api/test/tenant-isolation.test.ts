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
 * Cross-tenant isolation.
 *
 * This is the suite that matters most in a multi-tenant product. Every
 * brand-scoped route is checked against a second brand's resources, because
 * the failure mode -- one customer reading or editing another's data -- is the
 * kind that ends the business rather than merely annoying someone.
 *
 * The rule this enforces: ownership is checked in the *service*, so it holds
 * no matter which route reaches it.
 */
describe('cross-tenant isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function twoBrands() {
    const brandA = await makeBrand({ companyName: 'Brand A' });
    const brandB = await makeBrand({ companyName: 'Brand B' });
    const campaignB = await makeCampaign(brandB.id);
    const authA = await login(app, brandA.email);
    return { brandA, brandB, campaignB, authA };
  }

  it('refuses to read another brand’s campaign', async () => {
    const { campaignB, authA } = await twoBrands();

    const res = await app.inject({
      method: 'GET',
      url: `/api/brand/campaigns/${campaignB.id}`,
      headers: authA.authHeader,
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses to edit another brand’s campaign', async () => {
    const { campaignB, authA } = await twoBrands();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/brand/campaigns/${campaignB.id}`,
      headers: authA.authHeader,
      payload: { name: 'Renamed by a stranger' },
    });

    expect(res.statusCode).toBe(403);

    const unchanged = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignB.id },
    });
    expect(unchanged.name).toBe(campaignB.name);
  });

  it('refuses to transition another brand’s campaign', async () => {
    const { campaignB, authA } = await twoBrands();

    const res = await app.inject({
      method: 'POST',
      url: `/api/brand/campaigns/${campaignB.id}/transition`,
      headers: authA.authHeader,
      payload: { to: 'ENDED' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses to read or create another brand’s API keys', async () => {
    const { campaignB, authA } = await twoBrands();

    const list = await app.inject({
      method: 'GET',
      url: `/api/brand/campaigns/${campaignB.id}/api-keys`,
      headers: authA.authHeader,
    });
    expect(list.statusCode).toBe(403);

    const create = await app.inject({
      method: 'POST',
      url: `/api/brand/campaigns/${campaignB.id}/api-keys`,
      headers: authA.authHeader,
      payload: { label: 'stolen' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('never lists another brand’s campaigns, conversions or affiliates', async () => {
    const { brandB, campaignB, authA } = await twoBrands();

    // Give brand B an affiliate so their list is non-empty.
    const affiliate = await makeAffiliate();
    await makeRelationship(brandB.id, affiliate.id);

    const campaigns = await app.inject({
      method: 'GET',
      url: '/api/brand/campaigns',
      headers: authA.authHeader,
    });
    expect((campaigns.json() as { items: unknown[] }).items).toHaveLength(0);

    const affiliates = await app.inject({
      method: 'GET',
      url: '/api/brand/affiliates',
      headers: authA.authHeader,
    });
    expect(affiliates.json()).toHaveLength(0);

    const conversions = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions',
      headers: authA.authHeader,
    });
    expect(conversions.json()).toHaveLength(0);

    // And brand B's campaign really does exist -- otherwise these assertions
    // would pass against an empty database and prove nothing.
    expect(
      await prisma.campaign.findUnique({ where: { id: campaignB.id } })
    ).not.toBeNull();
  });

  it('refuses to review another brand’s conversion', async () => {
    const { brandB, campaignB, authA } = await twoBrands();
    const affiliate = await makeAffiliate();
    await makeRelationship(brandB.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaignB.id);

    const conversion = await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: campaignB.id,
        affiliateId: affiliate.id,
        externalOrderId: 'order-b-1',
        conversionValue: '100.00',
        commissionAmount: '20.00',
        status: 'PENDING',
        occurredAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/brand/conversions/${conversion.id}/review`,
      headers: authA.authHeader,
      payload: { status: 'approved' },
    });

    expect(res.statusCode).toBe(403);
    const after = await prisma.conversion.findUniqueOrThrow({
      where: { id: conversion.id },
    });
    expect(after.status).toBe('PENDING');
  });

  it('refuses to toggle another affiliate’s tracking link', async () => {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);

    const owner = await makeAffiliate();
    const stranger = await makeAffiliate();
    await makeRelationship(brand.id, owner.id);
    await makeRelationship(brand.id, stranger.id);

    const link = await makeTrackingLink(owner.id, campaign.id);
    const strangerAuth = await login(app, stranger.email);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/affiliate/links/${link.id}`,
      headers: strangerAuth.authHeader,
      payload: { isActive: false },
    });

    expect(res.statusCode).toBe(403);
    const after = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(after.isActive).toBe(true);
  });

  it('keeps roles apart', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    // An affiliate token on a brand route is a 403, not a 404: the route
    // exists, they are simply not allowed to use it.
    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/campaigns',
      headers: auth.authHeader,
    });
    expect(res.statusCode).toBe(403);

    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/admin/fraud-reviews',
      headers: auth.authHeader,
    });
    expect(adminRes.statusCode).toBe(403);
  });

  it('rejects unauthenticated access to every protected route', async () => {
    const protectedRoutes = [
      ['GET', '/api/brand/campaigns'],
      ['GET', '/api/brand/conversions'],
      ['GET', '/api/brand/affiliates'],
      ['GET', '/api/brand/analytics'],
      ['GET', '/api/affiliate/links'],
      ['GET', '/api/affiliate/analytics'],
      ['GET', '/api/affiliate/earnings/summary'],
      ['GET', '/api/affiliate/applications'],
      ['GET', '/api/admin/fraud-reviews'],
    ] as const;

    for (const [method, url] of protectedRoutes) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
