import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
} from '@affiliate/analytics';
import { WEBHOOK_HEADERS } from '@affiliate/shared';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { webhookService, enqueueWebhookEvent } from '../src/services/webhook.service';
import { HttpWebhookTransport } from '../src/lib/webhook-transport';
import { verifyPostbackSignature } from '../src/lib/postback-signature';
import { startStubEndpoint, type StubEndpoint } from './webhook-stub';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
  makeWebhookEndpoint,
} from './factories';

/**
 * A transport that will dial loopback.
 *
 * The default one refuses private addresses, which is the behaviour the
 * routes depend on and which a separate test asserts. Here it is turned off
 * explicitly rather than through configuration, so that reading the test tells
 * you the guard was relaxed and where.
 */
const loopbackTransport = new HttpWebhookTransport({ allowPrivateTargets: true });

function deliveryService() {
  return webhookService(loopbackTransport);
}

/** Queues one delivery straight to an endpoint, bypassing the event sources. */
async function queueDelivery(endpointId: string) {
  return prisma.webhookDelivery.create({
    data: {
      endpointId,
      eventType: 'conversion.approved',
      payload: { conversionId: 'c1' },
    },
  });
}

/** Far enough ahead that any jittered backoff has elapsed and the breaker has cooled. */
function later(passes: number) {
  return new Date(Date.now() + passes * (BREAKER_COOLDOWN_MS + 60_000));
}

describe('outbound webhooks', () => {
  let app: FastifyInstance;
  const stubs: StubEndpoint[] = [];

  async function stub(respond: (n: number) => number | 'hang') {
    const created = await startStubEndpoint(respond);
    stubs.push(created);
    return created;
  }

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await Promise.all(stubs.map((s) => s.close()));
    await app.close();
  });

  describe('the outbox', () => {
    it('writes the delivery inside the caller’s transaction', async () => {
      // The property the whole design rests on. If the state change rolls
      // back the event must go with it -- there must be no window in which a
      // brand is told about a conversion that was never approved.
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id);

      await expect(
        prisma.$transaction(async (tx) => {
          await enqueueWebhookEvent(tx, {
            brandId: brand.id,
            eventType: 'conversion.approved',
            payload: { conversionId: 'c1' },
          });
          throw new Error('the state change failed');
        })
      ).rejects.toThrow();

      expect(await prisma.webhookDelivery.count({ where: { endpointId: record.id } })).toBe(0);
    });

    it('emits conversion.approved when a brand approves a sale', async () => {
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id);
      const campaign = await makeCampaign(brand.id, { lockPeriodDays: 0 });
      const affiliate = await makeAffiliate();
      await makeRelationship(brand.id, affiliate.id);
      const link = await makeTrackingLink(affiliate.id, campaign.id);

      const conversion = await prisma.conversion.create({
        data: {
          trackingLinkId: link.id,
          campaignId: campaign.id,
          affiliateId: affiliate.id,
          externalOrderId: 'order-1',
          conversionValue: '100.00',
          commissionAmount: '20.00',
          status: 'PENDING',
          occurredAt: new Date(),
        },
      });

      const brandAuth = await login(app, brand.email);
      await app.inject({
        method: 'POST',
        url: `/api/brand/conversions/${conversion.id}/review`,
        headers: brandAuth.authHeader,
        payload: { status: 'approved' },
      });

      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId: record.id },
      });
      expect(delivery.eventType).toBe('conversion.approved');
      const payload = delivery.payload as Record<string, unknown>;
      expect(payload.orderId).toBe('order-1');
      // Money is a string over the wire, two decimals, never a float.
      expect(payload.commissionAmount).toBe('20.00');
    });

    it('does not emit to an endpoint that never subscribed to the event', async () => {
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, {
        eventTypes: ['payout.completed'],
      });

      await enqueueWebhookEvent(prisma, {
        brandId: brand.id,
        eventType: 'conversion.approved',
        payload: {},
      });

      expect(await prisma.webhookDelivery.count({ where: { endpointId: record.id } })).toBe(0);
    });
  });

  describe('delivery', () => {
    it('retries a 500 and records one row, delivered', async () => {
      const endpoint = await stub((n) => (n === 1 ? 500 : 200));
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      await queueDelivery(record.id);

      const svc = deliveryService();
      const first = await svc.deliverDue();
      expect(first.failed).toBe(1);

      const second = await svc.deliverDue(later(1));
      expect(second.delivered).toBe(1);

      // Two attempts at the socket, one row in the log. A retry is not a new
      // event, and a delivery log that showed two would make a brand chasing a
      // duplicate look in the wrong place.
      expect(endpoint.requests).toHaveLength(2);
      const rows = await prisma.webhookDelivery.findMany({ where: { endpointId: record.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('DELIVERED');
      expect(rows[0]!.attempts).toBe(2);
      expect(rows[0]!.deliveredAt).not.toBeNull();
    });

    it('signs with the endpoint secret and sends the documented headers', async () => {
      const endpoint = await stub(() => 200);
      const brand = await makeBrand();
      const { record, secret } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      const delivery = await queueDelivery(record.id);

      await deliveryService().deliverDue();

      const sent = endpoint.requests[0]!;
      const header = (name: string) => sent.headers[name.toLowerCase()] as string;

      expect(header(WEBHOOK_HEADERS.deliveryId)).toBe(delivery.id);
      expect(header(WEBHOOK_HEADERS.eventType)).toBe('conversion.approved');

      // The same scheme as an inbound postback, verified with the same
      // function a brand would be given. If these ever diverge this fails.
      expect(
        verifyPostbackSignature({
          secret,
          timestamp: header(WEBHOOK_HEADERS.timestamp),
          signature: header(WEBHOOK_HEADERS.signature),
          rawBody: sent.body,
          nowMs: Date.now(),
        })
      ).toEqual({ ok: true });

      const body = JSON.parse(sent.body) as { id: string; type: string };
      // The delivery id is in the body as well as the header, because that is
      // the key a receiver deduplicates on and it must survive a proxy that
      // strips unknown headers.
      expect(body.id).toBe(delivery.id);
      expect(body.type).toBe('conversion.approved');
    });

    it('gives up after exactly six attempts', async () => {
      const endpoint = await stub(() => 503);
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      await queueDelivery(record.id);

      const svc = deliveryService();
      // Each pass is far enough ahead that both the backoff and the breaker
      // cooldown have elapsed, so every pass gets exactly one attempt through.
      for (let pass = 1; pass <= WEBHOOK_MAX_ATTEMPTS; pass++) {
        await svc.deliverDue(later(pass));
      }

      const row = await prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId: record.id },
      });
      expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
      expect(row.status).toBe('FAILED');
      expect(row.lastStatusCode).toBe(503);

      // No seventh. A FAILED delivery is not eligible again without a replay.
      await svc.deliverDue(later(WEBHOOK_MAX_ATTEMPTS + 1));
      expect(endpoint.requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    });

    it('abandons an endpoint that accepts the request and never answers', async () => {
      // The failure mode people forget. Without a deadline this worker is held
      // for as long as the far end cares to hold it, and nothing alerts.
      const endpoint = await stub(() => 'hang');
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      await queueDelivery(record.id);

      const startedAt = Date.now();
      await deliveryService().deliverDue();
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(15_000);

      const row = await prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId: record.id },
      });
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain('Timed out');
      expect(row.lastStatusCode).toBeNull();
    });

    it('disables an endpoint that returns 410 and fails its backlog', async () => {
      const endpoint = await stub(() => 410);
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      await queueDelivery(record.id);
      await queueDelivery(record.id);

      await deliveryService().deliverDue();

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.status).toBe('DISABLED');
      expect(after.disabledReason).toContain('410');

      // One request, not two. A subscriber that has torn down an integration
      // should not have to say so twice.
      expect(endpoint.requests).toHaveLength(1);
      const rows = await prisma.webhookDelivery.findMany({ where: { endpointId: record.id } });
      expect(rows.every((r) => r.status === 'FAILED')).toBe(true);
    });

    it('refuses a private target at delivery time', async () => {
      // The default transport, not the loopback one. Registration already
      // rejects this url; this asserts the second, independent check on the
      // address the socket would use, which is the one DNS cannot race.
      const endpoint = await stub(() => 200);
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      await queueDelivery(record.id);

      await webhookService().deliverDue();

      expect(endpoint.requests).toHaveLength(0);
      const row = await prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId: record.id },
      });
      expect(row.lastError).toMatch(/private address|private or reserved/);
    });
  });

  describe('the circuit breaker', () => {
    it('opens after five failures and does not attempt the sixth delivery', async () => {
      const endpoint = await stub(() => 500);
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 1; i++) {
        await queueDelivery(record.id);
      }

      const result = await deliveryService().deliverDue();

      // Five requests left the process; the sixth never did. Without the
      // breaker one dead subscriber spends the whole delivery budget on
      // requests that cannot succeed.
      expect(endpoint.requests).toHaveLength(BREAKER_FAILURE_THRESHOLD);
      expect(result.failed).toBe(BREAKER_FAILURE_THRESHOLD);
      expect(result.skipped).toBe(1);

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.breakerState).toBe('OPEN');
      expect(after.consecutiveFailures).toBe(BREAKER_FAILURE_THRESHOLD);

      // The skipped delivery kept its full budget: it is parked, not spent.
      const parked = await prisma.webhookDelivery.findMany({
        where: { endpointId: record.id, attempts: 0 },
      });
      expect(parked).toHaveLength(1);
      expect(parked[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it('lets exactly one probe through, and no more when it fails', async () => {
      const endpoint = await stub(() => 500);
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 3; i++) {
        await queueDelivery(record.id);
      }

      const svc = deliveryService();
      await svc.deliverDue();
      expect(endpoint.requests).toHaveLength(BREAKER_FAILURE_THRESHOLD);

      // Past the cooldown, with eight deliveries due. Exactly one leaves,
      // because the state changes on admission rather than on the result --
      // otherwise every queued delivery passes the same open door and the
      // "probe" is however many are pending.
      const probePass = await svc.deliverDue(new Date(Date.now() + BREAKER_COOLDOWN_MS + 1_000));
      expect(endpoint.requests).toHaveLength(BREAKER_FAILURE_THRESHOLD + 1);
      expect(probePass.failed).toBe(1);

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: record.id } });
      // Straight back to open: the endpoint has just told us it is still down,
      // and spending four more requests to confirm that is the cost the
      // breaker exists to avoid.
      expect(after.breakerState).toBe('OPEN');
    });

    it('closes on a successful probe and resumes the backlog', async () => {
      const endpoint = await stub((n) => (n <= BREAKER_FAILURE_THRESHOLD ? 500 : 200));
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id, { url: endpoint.url });
      for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 3; i++) {
        await queueDelivery(record.id);
      }

      const svc = deliveryService();
      await svc.deliverDue();
      await svc.deliverDue(new Date(Date.now() + BREAKER_COOLDOWN_MS + 1_000));

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.breakerState).toBe('CLOSED');
      expect(after.consecutiveFailures).toBe(0);

      // The probe succeeded, so the deliveries behind it went out in the same
      // pass. A breaker that made a recovered endpoint wait a further minute
      // per delivery would turn a one-minute outage into an hour of backlog.
      const pending = await prisma.webhookDelivery.count({
        where: { endpointId: record.id, status: 'PENDING' },
      });
      expect(pending).toBe(0);
    });
  });

  describe('the brand-facing API', () => {
    it('registers an endpoint and returns the secret exactly once', async () => {
      const brand = await makeBrand();
      const auth = await login(app, brand.email);

      const created = await app.inject({
        method: 'POST',
        url: '/api/brand/webhooks',
        headers: auth.authHeader,
        payload: {
          url: 'https://hooks.example.com/affiliate',
          eventTypes: ['conversion.approved'],
        },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { id: string; secret: string };
      expect(body.secret).toMatch(/^whsec_/);

      const listed = await app.inject({
        method: 'GET',
        url: '/api/brand/webhooks',
        headers: auth.authHeader,
      });
      const rows = listed.json() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      // Never again. A stolen session must not be able to read back the
      // credential an existing integration signs with.
      expect(rows[0]).not.toHaveProperty('secret');
      expect(rows[0]).not.toHaveProperty('secretEncrypted');
    });

    it('refuses a url that points inside our own network', async () => {
      const brand = await makeBrand();
      const auth = await login(app, brand.email);

      for (const url of [
        'https://127.0.0.1/hook',
        'https://10.0.0.1/hook',
        'https://169.254.169.254/latest/meta-data/',
        'https://localhost/hook',
        'http://hooks.example.com/affiliate',
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/brand/webhooks',
          headers: auth.authHeader,
          payload: { url, eventTypes: ['conversion.approved'] },
        });
        expect(res.statusCode, url).toBe(400);
      }

      expect(await prisma.webhookEndpoint.count()).toBe(0);
    });

    it('never shows one brand another’s deliveries', async () => {
      const owner = await makeBrand();
      const stranger = await makeBrand();
      const { record } = await makeWebhookEndpoint(owner.id);
      await queueDelivery(record.id);
      const strangerAuth = await login(app, stranger.email);

      const res = await app.inject({
        method: 'GET',
        url: `/api/brand/webhooks/${record.id}/deliveries`,
        headers: strangerAuth.authHeader,
      });
      expect(res.statusCode).toBe(403);
    });

    it('replays a failed delivery with a fresh budget', async () => {
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id);
      const delivery = await queueDelivery(record.id);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', attempts: WEBHOOK_MAX_ATTEMPTS, lastError: 'gone away' },
      });

      const auth = await login(app, brand.email);
      const res = await app.inject({
        method: 'POST',
        url: `/api/brand/webhook-deliveries/${delivery.id}/replay`,
        headers: auth.authHeader,
      });
      expect(res.statusCode).toBe(200);

      const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe('PENDING');
      // A replay that inherited an exhausted budget would make one attempt and
      // stop, which is not what an operator asking for a replay means.
      expect(after.attempts).toBe(0);
      expect(after.lastError).toBeNull();
    });

    it('refuses to replay a delivery that has not failed', async () => {
      const brand = await makeBrand();
      const { record } = await makeWebhookEndpoint(brand.id);
      const delivery = await queueDelivery(record.id);

      const auth = await login(app, brand.email);
      const res = await app.inject({
        method: 'POST',
        url: `/api/brand/webhook-deliveries/${delivery.id}/replay`,
        headers: auth.authHeader,
      });

      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('DELIVERY_NOT_FAILED');
    });
  });
});
