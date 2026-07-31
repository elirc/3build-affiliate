import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WEBHOOK_MAX_ATTEMPTS,
  admit,
  nextDelayMs,
  onFailure,
  onSuccess,
  seedFrom,
  type BreakerSnapshot,
} from '@affiliate/analytics';
import {
  WEBHOOK_HEADERS,
  type CreateWebhookEndpointInput,
  type ListDeliveriesQuery,
  type WebhookEventType,
} from '@affiliate/shared';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { Errors } from '../lib/errors';
import { logger } from '../lib/logger';
import { mapWithConcurrency } from '../lib/concurrency';
import { openSecret, sealSecret } from '../lib/secret-box';
import { signPostback } from '../lib/postback-signature';
import { parseWebhookUrl } from '../lib/ssrf';
import { HttpWebhookTransport, type WebhookTransport } from '../lib/webhook-transport';
import { webhookRepository } from '../repositories/webhook.repository';

/** A transaction client, so callers can emit inside their own transaction. */
type Tx = Prisma.TransactionClient | PrismaClient;

type DueDelivery = Prisma.WebhookDeliveryGetPayload<{ include: { endpoint: true } }>;

/**
 * How many endpoints are dialled at once.
 *
 * A bound on *us*, not on any one subscriber. Without it a pass that claims
 * fifty due deliveries opens fifty sockets, each able to hold for the full
 * five-second timeout, and the load we put on the outside world is decided by
 * whatever happened to be pending rather than by anything we chose. Deliveries
 * to a single endpoint go one at a time, so this is also the ceiling on
 * concurrent requests overall.
 */
export const MAX_CONCURRENT_DELIVERIES = 10;

/** How many due deliveries one pass claims. */
const BATCH_SIZE = 50;

/**
 * Emits an event to every endpoint of `brandId` subscribed to it.
 *
 * Takes `tx` rather than reaching for the global client, exactly as
 * `enqueueNotification` does and for the same reason: if the caller's
 * transaction rolls back these rows go with it. There is no window in which a
 * brand is told about a conversion that was never approved, and none in which
 * a conversion is approved with no record that a webhook was owed.
 *
 * Returns how many rows were written, which is zero for the ordinary case of a
 * brand with no webhooks configured.
 */
export async function enqueueWebhookEvent(
  tx: Tx,
  input: {
    brandId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
  }
): Promise<number> {
  const endpoints = await tx.webhookEndpoint.findMany({
    where: {
      brandId: input.brandId,
      status: 'ACTIVE',
      eventTypes: { has: input.eventType },
    },
    select: { id: true },
  });

  for (const endpoint of endpoints) {
    await tx.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonObject,
      },
    });
  }

  return endpoints.length;
}

/**
 * The body a subscriber receives.
 *
 * `id` is the delivery, not the event: a retry carries the same id, which is
 * what makes "deduplicate on X-Delivery-Id" a workable instruction. Exactly
 * once is not available across a network boundary -- an endpoint that accepts
 * a request and then times out has been delivered to and we have no way to
 * know it -- so we promise at least once and give receivers the key they need.
 * That is BE-02 seen from the other side.
 */
function deliveryBody(delivery: {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}): string {
  return JSON.stringify({
    id: delivery.id,
    type: delivery.eventType,
    createdAt: delivery.createdAt.toISOString(),
    data: delivery.payload,
  });
}

function breakerOf(endpoint: {
  breakerState: BreakerSnapshot['state'];
  consecutiveFailures: number;
  breakerOpenedAt: Date | null;
}): BreakerSnapshot {
  return {
    state: endpoint.breakerState,
    consecutiveFailures: endpoint.consecutiveFailures,
    openedAt: endpoint.breakerOpenedAt?.getTime() ?? null,
  };
}

function toBreakerColumns(snapshot: BreakerSnapshot) {
  return {
    breakerState: snapshot.state,
    consecutiveFailures: snapshot.consecutiveFailures,
    breakerOpenedAt: snapshot.openedAt === null ? null : new Date(snapshot.openedAt),
  };
}

/** Groups a batch by endpoint, keeping each endpoint's deliveries in order. */
function byEndpoint(deliveries: DueDelivery[]): DueDelivery[][] {
  const groups = new Map<string, DueDelivery[]>();
  for (const delivery of deliveries) {
    const existing = groups.get(delivery.endpointId);
    if (existing) existing.push(delivery);
    else groups.set(delivery.endpointId, [delivery]);
  }
  return [...groups.values()];
}

export function webhookService(
  transport: WebhookTransport = new HttpWebhookTransport({
    allowPrivateTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
  })
) {
  const repo = webhookRepository(prisma);

  async function assertOwnsEndpoint(brandId: string, endpointId: string) {
    const endpoint = await repo.findEndpointById(endpointId);
    if (!endpoint) throw Errors.notFound('Webhook endpoint');
    // In the service rather than the route: the routes are not the only
    // caller, and an ownership check that lives in one of them is a check the
    // next caller silently does without.
    if (endpoint.brandId !== brandId) throw Errors.forbidden();
    return endpoint;
  }

  /**
   * One attempt at one delivery. Returns the breaker state that results.
   *
   * The breaker snapshot is threaded through rather than re-read, because a
   * pass can hold several deliveries for the same endpoint and re-reading the
   * row between them would lose the failures this pass has already seen.
   */
  async function attemptDelivery(
    delivery: DueDelivery,
    breaker: BreakerSnapshot,
    now: Date
  ): Promise<{
    outcome: 'delivered' | 'failed';
    breaker: BreakerSnapshot;
    /** Set when the endpoint told us to stop. The caller must not continue. */
    endpointDisabled: boolean;
  }> {
    const endpoint = delivery.endpoint;

    let secret: string;
    try {
      secret = openSecret(endpoint.secretEncrypted, env.POSTBACK_ENCRYPTION_KEY);
    } catch (err) {
      // A wrong encryption key or a tampered row. An operator problem rather
      // than the subscriber's, and one no number of retries will fix -- so it
      // fails loudly instead of spending six attempts and the breaker on it.
      logger.error({ err, endpointId: endpoint.id }, 'Cannot decrypt webhook secret');
      await repo.updateDelivery(delivery.id, {
        status: 'FAILED',
        lastError: 'Signing secret could not be decrypted',
      });
      return { outcome: 'failed', breaker, endpointDisabled: false };
    }

    const body = deliveryBody(delivery);
    // Wall clock, not the injected `now`. That one exists so a test can
    // simulate the passage of time for scheduling; this is a claim about when
    // the request actually left, and a receiver checks it against their own
    // clock to bound how long a captured request stays replayable.
    const timestamp = String(Date.now());

    const result = await transport.send({
      url: endpoint.url,
      body,
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_HEADERS.deliveryId]: delivery.id,
        [WEBHOOK_HEADERS.eventType]: delivery.eventType,
        [WEBHOOK_HEADERS.timestamp]: timestamp,
        // The same HMAC scheme as an inbound postback, timestamp inside the
        // signature rather than merely beside it. A second scheme would be a
        // second thing to get wrong, and integrators building against
        // 03-postback-integration.md already have code that verifies this one.
        [WEBHOOK_HEADERS.signature]: signPostback(secret, timestamp, body),
      },
    });

    const attempts = delivery.attempts + 1;
    const code = result.statusCode;

    if (code !== null && code >= 200 && code < 300) {
      await repo.updateDelivery(delivery.id, {
        status: 'DELIVERED',
        attempts,
        lastStatusCode: code,
        lastError: null,
        deliveredAt: new Date(),
      });
      const next = onSuccess(breaker);
      await repo.updateEndpoint(endpoint.id, toBreakerColumns(next));
      return { outcome: 'delivered', breaker: next, endpointDisabled: false };
    }

    // 410 Gone is the one status that means "stop asking", and honouring it
    // matters because the alternative is six attempts at every future event
    // forever. A subscriber tearing down an integration has no other way to
    // tell us, and it does not count as a breaker failure -- the endpoint
    // answered us clearly.
    if (code === 410) {
      await repo.updateEndpoint(endpoint.id, {
        status: 'DISABLED',
        disabledReason: 'Endpoint returned 410 Gone',
      });
      await repo.updateDelivery(delivery.id, {
        status: 'FAILED',
        attempts,
        lastStatusCode: 410,
        lastError: 'Endpoint returned 410 Gone',
      });
      // The backlog goes with it. Leaving it PENDING behind a disabled
      // endpoint shows a brand a queue that never drains, with no reason why.
      await repo.failPendingForEndpoint(
        endpoint.id,
        'Endpoint was disabled after returning 410 Gone'
      );
      return { outcome: 'failed', breaker, endpointDisabled: true };
    }

    const error = result.error ?? `Endpoint returned ${code ?? 'no status'}`;
    const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;

    await repo.updateDelivery(delivery.id, {
      status: exhausted ? 'FAILED' : 'PENDING',
      attempts,
      lastStatusCode: code,
      lastError: error.slice(0, 500),
      ...(exhausted
        ? {}
        : {
            // Full jitter, seeded on the delivery id and the attempt. A
            // thousand deliveries failing at the same instant must not all
            // come back at the same instant.
            nextAttemptAt: new Date(
              now.getTime() + nextDelayMs(attempts, seedFrom(delivery.id, attempts))
            ),
          }),
    });

    const next = onFailure(breaker, now.getTime());
    if (next.state === 'OPEN' && breaker.state !== 'OPEN') {
      // `from` separates the two ways in: CLOSED means the endpoint has just
      // failed five in a row, HALF_OPEN means a recovery probe failed and it
      // is still down. They call for different responses from whoever is
      // reading this, so the log has to tell them apart.
      logger.warn(
        {
          endpointId: endpoint.id,
          url: endpoint.url,
          from: breaker.state,
          consecutiveFailures: next.consecutiveFailures,
          lastError: error.slice(0, 200),
        },
        'Webhook circuit breaker opened'
      );
    }
    await repo.updateEndpoint(endpoint.id, toBreakerColumns(next));
    return { outcome: 'failed', breaker: next, endpointDisabled: false };
  }

  /**
   * Works through one endpoint's due deliveries, one at a time.
   *
   * Sequential on purpose. The breaker has to see the result of each attempt
   * before deciding on the next, or five deliveries dispatched together all
   * pass a closed breaker and the sixth -- the one the breaker exists to stop
   * -- goes out with them. It also means a struggling subscriber gets one
   * request at a time from us rather than however many we happen to be
   * holding.
   */
  async function drainEndpoint(group: DueDelivery[], now: Date) {
    let breaker = breakerOf(group[0]!.endpoint);
    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    let disabled = false;

    for (const delivery of group) {
      if (disabled) {
        // The 410 handler already failed the rest of this endpoint's backlog.
        skipped += 1;
        continue;
      }

      const decision = admit(breaker, now.getTime());
      if (!decision.allow) {
        // Parked rather than attempted, and pushed past the cooldown so the
        // next few passes do not keep re-reading rows they already know they
        // cannot send. No attempt is spent: the budget is for failures the
        // endpoint actually produced.
        await repo.updateDelivery(delivery.id, {
          nextAttemptAt: new Date(decision.retryAt ?? now.getTime() + 1_000),
        });
        skipped += 1;
        continue;
      }

      if (decision.next.state !== breaker.state) {
        // Persisted before the request goes out, because admitting a probe is
        // itself the state change that makes it the only probe.
        breaker = decision.next;
        await repo.updateEndpoint(delivery.endpointId, toBreakerColumns(breaker));
      }

      const result = await attemptDelivery(delivery, breaker, now);
      breaker = result.breaker;
      // A 410 disabled the endpoint. Carrying on down the list would dial an
      // endpoint that has just told us it no longer exists.
      disabled = result.endpointDisabled;
      if (result.outcome === 'delivered') delivered += 1;
      else failed += 1;
    }

    return { delivered, failed, skipped };
  }

  return {
    /**
     * Registers an endpoint. The signing secret is returned once and never
     * again -- we *can* decrypt it, because we have to sign with it, but not
     * exposing a "show me the secret" endpoint means a stolen session cannot
     * exfiltrate an existing integration's credential.
     */
    async createEndpoint(brandId: string, input: CreateWebhookEndpointInput) {
      // Throws a 400 for a private or malformed target. This is the usability
      // half of the SSRF guard; the half that cannot be raced is applied to
      // the resolved address at delivery time, because DNS is the registrant's
      // to change afterwards.
      parseWebhookUrl(input.url);

      const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
      const record = await repo.createEndpoint({
        brandId,
        url: input.url,
        secretEncrypted: sealSecret(secret, env.POSTBACK_ENCRYPTION_KEY),
        eventTypes: input.eventTypes,
      });

      return {
        id: record.id,
        url: record.url,
        eventTypes: record.eventTypes,
        status: record.status,
        createdAt: record.createdAt,
        secret,
      };
    },

    listEndpoints(brandId: string) {
      return repo.listEndpointsForBrand(brandId);
    },

    async deleteEndpoint(brandId: string, endpointId: string) {
      await assertOwnsEndpoint(brandId, endpointId);
      await repo.deleteEndpoint(endpointId);
      return { deleted: true };
    },

    async listDeliveries(
      brandId: string,
      endpointId: string,
      query: ListDeliveriesQuery
    ) {
      await assertOwnsEndpoint(brandId, endpointId);
      return repo.listDeliveriesForEndpoint(endpointId, {
        status: query.status,
        limit: query.limit,
      });
    },

    /**
     * Re-queues a delivery that gave up.
     *
     * The attempt count is reset, so a replay gets the full six attempts
     * again. That is the point of a manual replay: the operator is asserting
     * that whatever was broken has been fixed, and a replay inheriting an
     * exhausted budget would make one attempt and stop.
     */
    async replayDelivery(brandId: string, deliveryId: string) {
      const delivery = await repo.findDeliveryById(deliveryId);
      if (!delivery) throw Errors.notFound('Webhook delivery');
      if (delivery.endpoint.brandId !== brandId) throw Errors.forbidden();

      if (delivery.status !== 'FAILED') {
        throw Errors.invalidRequest(
          'DELIVERY_NOT_FAILED',
          'Only a failed delivery can be replayed'
        );
      }
      if (delivery.endpoint.status !== 'ACTIVE') {
        throw Errors.invalidRequest(
          'ENDPOINT_DISABLED',
          'This endpoint is disabled. Register a new one before replaying.'
        );
      }

      return repo.updateDelivery(deliveryId, {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        lastStatusCode: null,
      });
    },

    /**
     * Delivers one batch of due events.
     *
     * Exported for the same reason the other workers' passes are: a test runs
     * one pass and asserts, rather than starting an interval and hoping one
     * fired.
     */
    async deliverDue(now = new Date(), limit = BATCH_SIZE) {
      const due = await repo.listDue(now, limit);
      if (due.length === 0) return { delivered: 0, failed: 0, skipped: 0 };

      const results = await mapWithConcurrency(
        byEndpoint(due),
        MAX_CONCURRENT_DELIVERIES,
        (group) => drainEndpoint(group, now)
      );

      return results.reduce(
        (total, r) => ({
          delivered: total.delivered + r.delivered,
          failed: total.failed + r.failed,
          skipped: total.skipped + r.skipped,
        }),
        { delivered: 0, failed: 0, skipped: 0 }
      );
    },
  };
}
