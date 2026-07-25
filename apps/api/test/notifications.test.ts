import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  enqueueNotification,
  notificationService,
  type NotificationDelivery,
} from '../src/services/notification.service';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

describe('notification outbox', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes the notification inside the caller’s transaction', async () => {
    // The whole point of an outbox. If the state change rolls back, the
    // notification must go with it -- there must be no window in which
    // someone is told about something that did not happen.
    const affiliate = await makeAffiliate();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueNotification(tx, {
          userId: affiliate.id,
          type: 'payout_paid',
          payload: { amount: '100.00' },
        });
        throw new Error('the state change failed');
      })
    ).rejects.toThrow();

    expect(await prisma.notification.count()).toBe(0);
  });

  it('notifies an affiliate when their application is approved', async () => {
    const brand = await makeBrand();
    const affiliate = await makeAffiliate();
    const rel = await makeRelationship(brand.id, affiliate.id, 'PENDING');
    const brandAuth = await login(app, brand.email);

    await app.inject({
      method: 'POST',
      url: `/api/brand/affiliates/${rel.id}/review`,
      headers: brandAuth.authHeader,
      payload: { action: 'approve' },
    });

    const notification = await prisma.notification.findFirstOrThrow();
    expect(notification.userId).toBe(affiliate.id);
    expect(notification.type).toBe('application_approved');
    expect(notification.status).toBe('PENDING');
  });

  it('notifies an affiliate when a sale is reviewed', async () => {
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
        externalOrderId: 'o1',
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

    const brandAuth = await login(app, brand.email);
    await app.inject({
      method: 'POST',
      url: `/api/brand/conversions/${conversion.id}/review`,
      headers: brandAuth.authHeader,
      payload: { status: 'approved' },
    });

    const n = await prisma.notification.findFirstOrThrow();
    expect(n.type).toBe('conversion_approved');
    expect(n.userId).toBe(affiliate.id);
  });

  it('delivers pending notifications and marks them sent', async () => {
    const affiliate = await makeAffiliate();
    await enqueueNotification(prisma, {
      userId: affiliate.id,
      type: 'payout_paid',
      payload: { amount: '100.00' },
    });

    const send = vi.fn().mockResolvedValue(undefined);
    const svc = notificationService({ send } as NotificationDelivery);

    const result = await svc.deliverPending();

    expect(result.sent).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payout_paid', email: affiliate.email })
    );

    const n = await prisma.notification.findFirstOrThrow();
    expect(n.status).toBe('SENT');
    expect(n.sentAt).not.toBeNull();
  });

  it('retries a failure with backoff and gives up after five attempts', async () => {
    const affiliate = await makeAffiliate();
    await enqueueNotification(prisma, {
      userId: affiliate.id,
      type: 'payout_paid',
      payload: {},
    });

    const send = vi.fn().mockRejectedValue(new Error('provider down'));
    const svc = notificationService({ send } as NotificationDelivery);

    // First attempt fails and stays pending for a retry.
    await svc.deliverPending();
    let n = await prisma.notification.findFirstOrThrow();
    expect(n.attempts).toBe(1);
    expect(n.status).toBe('PENDING');
    expect(n.lastError).toContain('provider down');

    // Backoff: an immediate second pass does nothing.
    await svc.deliverPending();
    n = await prisma.notification.findFirstOrThrow();
    expect(n.attempts).toBe(1);

    // Push the clock forward past each backoff until it gives up.
    for (let i = 2; i <= 5; i++) {
      await svc.deliverPending(new Date(Date.now() + 365 * 86400 * 1000));
      n = await prisma.notification.findFirstOrThrow();
      expect(n.attempts).toBe(i);
    }

    expect(n.status).toBe('FAILED');
  });

  it('suppresses a type the user has opted out of', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    await app.inject({
      method: 'PUT',
      url: '/api/me/notification-preferences',
      headers: auth.authHeader,
      payload: { type: 'conversion_approved', enabled: false },
    });

    await enqueueNotification(prisma, {
      userId: affiliate.id,
      type: 'conversion_approved',
      payload: {},
    });

    const send = vi.fn();
    const svc = notificationService({ send } as NotificationDelivery);
    const result = await svc.deliverPending();

    expect(result.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
    // The row survives as a record that the event happened.
    expect(await prisma.notification.count()).toBe(1);
  });

  it('refuses to switch off a notification about money moving', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    for (const type of ['payout_paid', 'payout_failed', 'commission_clawed_back']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/me/notification-preferences',
        headers: auth.authHeader,
        payload: { type, enabled: false },
      });
      expect(res.statusCode, type).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'NOTIFICATION_MANDATORY'
      );
    }
  });

  it('sends a mandatory notification even when a preference row says otherwise', async () => {
    // Belt and braces: the API refuses to create such a preference, but a row
    // could arrive from a migration or by hand, and it must not suppress a
    // payout notice.
    const affiliate = await makeAffiliate();
    await prisma.notificationPreference.create({
      data: { userId: affiliate.id, type: 'payout_paid', enabled: false },
    });
    await enqueueNotification(prisma, {
      userId: affiliate.id,
      type: 'payout_paid',
      payload: {},
    });

    const send = vi.fn().mockResolvedValue(undefined);
    const result = await notificationService({ send } as NotificationDelivery)
      .deliverPending();

    expect(result.sent).toBe(1);
    expect(send).toHaveBeenCalled();
  });

  it('lists notifications with an unread count and marks them read', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    for (const type of ['payout_paid', 'conversion_approved'] as const) {
      await enqueueNotification(prisma, { userId: affiliate.id, type, payload: {} });
    }

    const list = await app.inject({
      method: 'GET',
      url: '/api/me/notifications',
      headers: auth.authHeader,
    });
    const body = list.json() as { items: Array<{ id: string }>; unread: number };
    expect(body.unread).toBe(2);

    const marked = await app.inject({
      method: 'POST',
      url: '/api/me/notifications/read',
      headers: auth.authHeader,
      payload: { ids: [body.items[0]!.id] },
    });
    expect((marked.json() as { marked: number }).marked).toBe(1);

    const after = await app.inject({
      method: 'GET',
      url: '/api/me/notifications',
      headers: auth.authHeader,
    });
    expect((after.json() as { unread: number }).unread).toBe(1);
  });

  it('never lets one user read or mark another’s notifications', async () => {
    const owner = await makeAffiliate();
    const stranger = await makeAffiliate();
    const strangerAuth = await login(app, stranger.email);

    const n = await enqueueNotification(prisma, {
      userId: owner.id,
      type: 'payout_paid',
      payload: {},
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/me/notifications',
      headers: strangerAuth.authHeader,
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    // An id alone must not be enough -- the update is scoped by user too.
    const marked = await app.inject({
      method: 'POST',
      url: '/api/me/notifications/read',
      headers: strangerAuth.authHeader,
      payload: { ids: [n.id] },
    });
    expect((marked.json() as { marked: number }).marked).toBe(0);

    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt
    ).toBeNull();
  });

  it('notifies on a clawback', async () => {
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
        externalOrderId: 'refund-1',
        conversionValue: '100.00',
        commissionAmount: '20.00',
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
        amount: '20.00',
        status: 'APPROVED',
      },
    });

    const brandAuth = await login(app, brand.email);
    await app.inject({
      method: 'POST',
      url: `/api/brand/conversions/${conversion.id}/reverse`,
      headers: brandAuth.authHeader,
      payload: { reason: 'Customer refunded' },
    });

    const n = await prisma.notification.findFirstOrThrow({
      where: { type: 'commission_clawed_back' },
    });
    // A silent deduction destroys trust faster than the deduction itself.
    expect((n.payload as { reason: string }).reason).toBe('Customer refunded');
    expect(await makeAdmin()).toBeTruthy();
  });
});
