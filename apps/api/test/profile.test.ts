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
  TEST_PASSWORD,
} from './factories';

describe('profile and payout settings', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('never returns the password hash or token version', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/me/profile',
      headers: auth.authHeader,
    });

    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('tokenVersion');
  });

  it('lets an affiliate edit their bio and social links', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/profile',
      headers: auth.authHeader,
      payload: {
        bio: 'I review developer tools.',
        socialLinks: { youtube: 'https://youtube.com/@me' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { bio: string }).bio).toBe('I review developer tools.');
  });

  it('refuses javascript: and http: social links', async () => {
    // These render as clickable links on the brand's review page, so a stored
    // javascript: URL would be XSS aimed at the brand about to approve them.
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    for (const bad of [
      'javascript:alert(document.cookie)',
      'http://insecure.example.com',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me/profile',
        headers: auth.authHeader,
        payload: { socialLinks: { x: bad } },
      });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('stops an affiliate setting brand-only fields', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/profile',
      headers: auth.authHeader,
      payload: { companyName: 'Not mine' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/profile',
      headers: auth.authHeader,
      // Silently ignoring this would let someone believe they had changed it.
      payload: { role: 'ADMIN' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('requires the current password to change the password', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: auth.authHeader,
      payload: { currentPassword: 'wrong-password', newPassword: 'NewPassword123!' },
    });

    // An access token left on a shared machine must not be enough to lock the
    // real owner out.
    expect(res.statusCode).toBe(401);
  });

  it('revokes every session when the password changes', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: auth.authHeader,
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'NewPassword123!' },
    });
    expect(res.statusCode).toBe(200);

    // Usually someone changes their password because they think another
    // person has it. Leaving that person logged in achieves nothing.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth.authHeader,
    });
    expect(after.statusCode).toBe(401);
  });

  it('marks a changed email as unverified and refuses a taken one', async () => {
    const affiliate = await makeAffiliate();
    const other = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const taken = await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: auth.authHeader,
      payload: { currentPassword: TEST_PASSWORD, newEmail: other.email },
    });
    expect(taken.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: auth.authHeader,
      payload: { currentPassword: TEST_PASSWORD, newEmail: 'brand-new@example.com' },
    });
    expect(ok.statusCode).toBe(200);
    // The new address is unproven until someone clicks a link sent to it.
    expect((ok.json() as { emailVerified: boolean }).emailVerified).toBe(false);
  });

  it('clears the other methods’ details when payout settings change', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    await app.inject({
      method: 'PUT',
      url: '/api/me/payout-settings',
      headers: auth.authHeader,
      payload: { method: 'paypal', paypalEmail: 'me@example.com' },
    });

    await app.inject({
      method: 'PUT',
      url: '/api/me/payout-settings',
      headers: auth.authHeader,
      payload: { method: 'manual', manualDetails: 'IBAN GB00 ...' },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: affiliate.id } });
    // Stale details from a method no longer in use must not linger where they
    // could be picked up by accident.
    expect(user.paypalEmail).toBeNull();
    expect(user.manualPayoutDetails).toBe('IBAN GB00 ...');
    expect(user.payoutMethod).toBe('MANUAL');
  });

  it('rejects payout settings missing the field the method needs', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/payout-settings',
      headers: auth.authHeader,
      payload: { method: 'paypal' }, // no address
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a payout by a method with no details on file', async () => {
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
        externalOrderId: 'o1',
        conversionValue: '500.00',
        commissionAmount: '100.00',
        status: 'APPROVED',
        occurredAt: new Date(),
      },
    });
    await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        conversionId: conversion.id,
        amount: '100.00',
        status: 'APPROVED',
      },
    });

    const auth = await login(app, affiliate.email);

    const before = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'paypal' },
    });
    // Previously this succeeded and an admin discovered the problem at the
    // point of transfer.
    expect(before.statusCode).toBe(400);
    expect((before.json() as { error: { code: string } }).error.code).toBe(
      'PAYOUT_DETAILS_MISSING'
    );

    await app.inject({
      method: 'PUT',
      url: '/api/me/payout-settings',
      headers: auth.authHeader,
      payload: { method: 'paypal', paypalEmail: 'me@example.com' },
    });

    const after = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: auth.authHeader,
      payload: { method: 'paypal' },
    });
    expect(after.statusCode).toBe(201);
  });

  it('keeps payout settings away from brands', async () => {
    const brand = await makeBrand();
    const auth = await login(app, brand.email);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/payout-settings',
      headers: auth.authHeader,
      payload: { method: 'paypal', paypalEmail: 'me@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});
