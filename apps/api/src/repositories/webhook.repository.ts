import type { Prisma } from '@prisma/client';
import type { DB } from '../config/prisma';

export function webhookRepository(db: DB) {
  return {
    createEndpoint: (data: {
      brandId: string;
      url: string;
      secretEncrypted: string;
      eventTypes: string[];
    }) => db.webhookEndpoint.create({ data }),

    /**
     * Never selects `secretEncrypted`. A list endpoint has no use for it, and
     * a field that is not selected cannot be accidentally serialised.
     */
    listEndpointsForBrand: (brandId: string) =>
      db.webhookEndpoint.findMany({
        where: { brandId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          url: true,
          eventTypes: true,
          status: true,
          disabledReason: true,
          breakerState: true,
          consecutiveFailures: true,
          breakerOpenedAt: true,
          createdAt: true,
        },
      }),

    findEndpointById: (id: string) => db.webhookEndpoint.findUnique({ where: { id } }),

    deleteEndpoint: (id: string) => db.webhookEndpoint.delete({ where: { id } }),

    /**
     * Deliveries that are due, newest endpoints and oldest events first.
     *
     * Includes the endpoint because delivery needs its url, secret and breaker
     * state; fetching them per delivery would be an N+1 on the hot path of the
     * only worker that talks to the outside world.
     */
    listDue: (now: Date, limit: number) =>
      db.webhookDelivery.findMany({
        where: {
          status: 'PENDING',
          nextAttemptAt: { lte: now },
          endpoint: { status: 'ACTIVE' },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
        include: { endpoint: true },
      }),

    listDeliveriesForEndpoint: (
      endpointId: string,
      opts: { status?: Prisma.EnumWebhookDeliveryStatusFilter['equals']; limit: number }
    ) =>
      db.webhookDelivery.findMany({
        where: {
          endpointId,
          ...(opts.status ? { status: opts.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: opts.limit,
      }),

    findDeliveryById: (id: string) =>
      db.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } }),

    updateDelivery: (id: string, data: Prisma.WebhookDeliveryUpdateInput) =>
      db.webhookDelivery.update({ where: { id }, data }),

    updateEndpoint: (id: string, data: Prisma.WebhookEndpointUpdateInput) =>
      db.webhookEndpoint.update({ where: { id }, data }),

    /**
     * Fails everything still queued for an endpoint.
     *
     * Used when a subscriber answers 410 Gone. Leaving the backlog PENDING for
     * an endpoint we will never call again would show a brand a queue that
     * never drains and no reason why.
     */
    failPendingForEndpoint: (endpointId: string, reason: string) =>
      db.webhookDelivery.updateMany({
        where: { endpointId, status: 'PENDING' },
        data: { status: 'FAILED', lastError: reason },
      }),
  };
}
