import { UAParser } from 'ua-parser-js';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { logger } from '../lib/logger';
import type { ClickEventPayload } from '@affiliate/shared';

const QUEUE_KEY = 'click_events';
const BATCH_INTERVAL_MS = 1000;
const BATCH_MAX = 100;

/**
 * Drains the click_events Redis list and writes a batch to Postgres on a
 * fixed interval. The redirect service uses LPUSH; we use RPOP for FIFO.
 * Counters on TrackingLink are denormalized — we increment them here.
 */
export async function startClickEventWorker() {
  logger.info('Click event worker started');

  const tick = async () => {
    const events: ClickEventPayload[] = [];
    for (let i = 0; i < BATCH_MAX; i++) {
      const raw = await redis.rpop(QUEUE_KEY);
      if (!raw) break;
      try {
        events.push(JSON.parse(raw));
      } catch (err) {
        logger.warn({ err, raw }, 'Skipping malformed click event');
      }
    }
    if (events.length === 0) return;

    const linkCounts = new Map<string, number>();

    try {
      await prisma.$transaction(async (tx) => {
        for (const e of events) {
          linkCounts.set(e.trackingLinkId, (linkCounts.get(e.trackingLinkId) ?? 0) + 1);
          const ua = new UAParser(e.userAgent);
          const dev = ua.getDevice().type ?? 'desktop';
          const browser = ua.getBrowser().name ?? null;
          const os = ua.getOS().name ?? null;
          await tx.clickEvent.create({
            data: {
              trackingLinkId: e.trackingLinkId,
              timestamp: new Date(e.timestamp),
              ipHash: e.ip,
              userAgent: e.userAgent,
              referrer: e.referrer || null,
              deviceType: dev,
              browser,
              os,
              attributionCookieId: e.cookieId,
              subIds: e.subIds && Object.keys(e.subIds).length > 0 ? e.subIds : undefined,
            },
          });
        }
        for (const [linkId, count] of linkCounts) {
          await tx.trackingLink.update({
            where: { id: linkId },
            data: { clickCount: { increment: count } },
          });
        }
      });
      logger.debug({ count: events.length }, 'Click events flushed');
    } catch (err) {
      logger.error({ err, count: events.length }, 'Click event flush failed');
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Worker tick failed'));
  }, BATCH_INTERVAL_MS);
}
