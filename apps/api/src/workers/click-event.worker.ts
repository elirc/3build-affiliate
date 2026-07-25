import { UAParser } from 'ua-parser-js';
import { normaliseSubIds } from '@affiliate/analytics';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';
import type { ClickEventPayload } from '@affiliate/shared';

export const QUEUE_KEY = 'click_events';

/**
 * Where a failed batch goes.
 *
 * Events are RPOPed off the main queue before the transaction runs, so a
 * failed flush previously lost them outright -- the log said "flush failed"
 * and the clicks were simply gone, with no way to tell how many or whose.
 * They now land here instead, where they can be counted and replayed.
 */
export const DLQ_KEY = 'click_events_dlq';

export const WORKER_NAME = 'click-event';
const BATCH_INTERVAL_MS = 1000;
const BATCH_MAX = 100;

/**
 * Drains the click_events Redis list and writes a batch to Postgres on a
 * fixed interval. The redirect service uses LPUSH; we use RPOP for FIFO.
 * Counters on TrackingLink are denormalized — we increment them here.
 */
/**
 * One drain-and-flush pass.
 *
 * Exported so tests can run exactly one batch and assert on the result,
 * instead of starting an interval and sleeping long enough to hope one fired.
 * A test that sleeps is a test that is either slow or flaky, usually both.
 */
function cappedSubIds(raw: Record<string, string> | undefined) {
  if (!raw) return undefined;
  const { subIds } = normaliseSubIds(raw);
  return Object.keys(subIds).length > 0 ? subIds : undefined;
}

export async function drainClickEvents(): Promise<{ flushed: number }> {
  const events: ClickEventPayload[] = [];
  // The original strings, so a failed batch can be requeued exactly as it
  // arrived rather than as our re-serialisation of it.
  const raws: string[] = [];

  for (let i = 0; i < BATCH_MAX; i++) {
    const raw = await redis.rpop(QUEUE_KEY);
    if (!raw) break;
    try {
      events.push(JSON.parse(raw));
      raws.push(raw);
    } catch (err) {
      // Malformed JSON will never parse, however many times it is retried.
      // Requeuing it would block the DLQ forever, so it is dropped and logged.
      logger.warn({ err, raw }, 'Discarding malformed click event');
    }
  }
  if (events.length === 0) return { flushed: 0 };

  try {
    await flushBatch(events);
  } catch (err) {
    // The events are already off the main queue. Without this they would be
    // gone; the DLQ is what makes the failure recoverable.
    if (raws.length > 0) {
      await redis.lpush(DLQ_KEY, ...raws).catch((dlqErr) => {
        logger.error(
          { err: dlqErr, count: raws.length },
          'Could not write failed click events to the dead-letter queue'
        );
      });
    }
    throw err;
  }

  return { flushed: events.length };
}

async function flushBatch(events: ClickEventPayload[]) {
  const linkCounts = new Map<string, number>();

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
          // Capped again here, not only at the redirect edge.
          //
          // The edge is where the caps belong for latency reasons, but this
          // worker consumes a Redis list -- it does not know who wrote to it,
          // and "the producer already validated this" is exactly the
          // assumption that stops being true when a second producer appears.
          // Enforcing it where the data is stored is what actually bounds the
          // column.
          subIds: cappedSubIds(e.subIds),
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

}

/**
 * Moves everything in the dead-letter queue back onto the main queue.
 *
 * Manual rather than automatic: a batch usually fails for a reason that is
 * still true a second later -- the database is down, a constraint is being
 * violated -- and an automatic retry loop turns one outage into a spin. An
 * operator decides when the cause is fixed.
 */
export async function replayDeadLetters(limit = 1000): Promise<{ replayed: number }> {
  let replayed = 0;
  for (let i = 0; i < limit; i++) {
    const raw = await redis.rpop(DLQ_KEY);
    if (!raw) break;
    await redis.lpush(QUEUE_KEY, raw);
    replayed += 1;
  }
  return { replayed };
}

export async function startClickEventWorker() {
  logger.info('Click event worker started');

  const tick = async () => {
    try {
      const { flushed } = await drainClickEvents();
      if (flushed > 0) logger.debug({ count: flushed }, 'Click events flushed');
      await beat(WORKER_NAME, BATCH_INTERVAL_MS, { lastFlushed: flushed });
    } catch (err) {
      logger.error({ err }, 'Click event flush failed; batch moved to the DLQ');
      // Still a beat: the worker is alive and failing, which is a different
      // state from absent, and the health page needs to tell them apart.
      await beat(WORKER_NAME, BATCH_INTERVAL_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Worker tick failed'));
  }, BATCH_INTERVAL_MS);
}
