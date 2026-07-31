import { UAParser } from 'ua-parser-js';
import {
  classifyTraffic,
  countsAsClick,
  normaliseSubIds,
  parseTrafficKind,
} from '@affiliate/analytics';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';
import { runWithContext } from '../lib/request-context';
import {
  clickEventPayloadSchema,
  sanitiseRequestId,
  type ClickEventPayload,
} from '@affiliate/shared';
import { bisectCommit } from '@affiliate/analytics';

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

/**
 * Where a message goes once it has failed enough times to be hopeless.
 *
 * Without this the DLQ is a loop: replay puts the poison message back on the
 * main queue, it fails again, and it returns. Parking takes it out of
 * circulation and makes the decision an operator's rather than a machine's.
 */
export const PARKED_KEY = 'click_events_parked';

/** Failures before a message is parked rather than retried again. */
export const MAX_ATTEMPTS = 3;

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

/**
 * The correlation id the redirect service attached, if it can be trusted.
 *
 * Re-validated here even though the redirect already validated it, for exactly
 * the reason the sub-ID cap is applied twice: this worker consumes a Redis list
 * and does not know who wrote to it. "The producer already checked" stops being
 * true the moment a second producer appears, and this value goes straight into
 * a log line, which is where an unvalidated string does its damage.
 *
 * A bad id costs the id and nothing else. Refusing the event over it would mean
 * losing a real click -- money somebody is owed -- to protect a debugging aid.
 */
function restoreRequestId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  return sanitiseRequestId((payload as { requestId?: unknown }).requestId) ?? undefined;
}

/**
 * Runs `fn` under the click's original request id, so everything it logs joins
 * up with the redirect that produced it.
 *
 * Per event rather than per batch: a drain covers up to a hundred unrelated
 * requests and there is no honest single id for it. When an event has no id the
 * work runs with no context at all rather than under a freshly generated one --
 * an id invented here would look like a correlation and correlate with nothing.
 */
function withRequestContext<T>(requestId: string | undefined, fn: () => T): T {
  return requestId === undefined ? fn() : runWithContext({ requestId }, fn);
}

export async function drainClickEvents(): Promise<{
  flushed: number;
  deadLettered: number;
}> {
  const events: ClickEventPayload[] = [];
  // The original strings, so a message can be dead-lettered exactly as it
  // arrived rather than as our re-serialisation of it.
  const raws: string[] = [];
  /** Prior failure history per event, for messages that arrived via a replay. */
  const priors: (DeadLetterEnvelope | null)[] = [];
  let deadLettered = 0;

  for (let i = 0; i < BATCH_MAX; i++) {
    const raw = await redis.rpop(QUEUE_KEY);
    if (!raw) break;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Malformed JSON will never parse, however many times it is retried.
      // Requeuing it would block the queue forever, so it is dropped, logged,
      // and counted.
      logger.warn({ err, raw: raw.slice(0, 200) }, 'Discarding malformed click event');
      continue;
    }

    // A replayed message arrives wrapped, carrying the attempt count it has
    // already accumulated. A fresh one from the redirect service does not.
    // Unwrapping here is what lets a message be given up on after three
    // failures instead of cycling forever.
    const envelope = asEnvelope(parsed);
    const payload = envelope ? envelope.payload : parsed;

    // Validated, not cast. The old code trusted `JSON.parse` and asserted the
    // type -- so an event missing `trackingLinkId` reached Prisma and failed
    // the transaction, taking the other 99 with it.
    //
    // Unlike malformed JSON these are *not* dropped. A schema failure may well
    // be a bug in our own producer, and silently discarding the evidence is
    // how you end up unable to explain a gap in the numbers.
    const result = clickEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      // Rebound to the originating request, so the "click event parked" line
      // here and the redirect line that produced it share an id. Without this
      // the worker's log says a click was dropped but not which one, and the
      // trail ends at the queue.
      await withRequestContext(restoreRequestId(payload), () =>
        deadLetter(
          JSON.stringify(payload),
          `schema: ${result.error.issues[0]?.message ?? 'invalid'}`,
          envelope ?? undefined
        )
      );
      deadLettered += 1;
      continue;
    }

    events.push(result.data as ClickEventPayload);
    raws.push(JSON.stringify(payload));
    priors.push(envelope);
  }

  if (events.length === 0) return { flushed: 0, deadLettered };

  // Bisecting rather than failing the batch.
  //
  // A foreign key that does not resolve cannot be caught by a schema -- only
  // the database knows. Previously one such event rolled back the whole
  // transaction and sent all 100 to the DLQ, where replay fed the poison
  // message straight back in and it happened again.
  const outcome = await bisectCommit(events, flushBatch);

  for (const failure of outcome.failed) {
    const index = events.indexOf(failure.item);
    const raw = index >= 0 ? raws[index]! : JSON.stringify(failure.item);
    await withRequestContext(restoreRequestId(failure.item), () =>
      deadLetter(
        raw,
        String(failure.error).slice(0, 500),
        index >= 0 ? (priors[index] ?? undefined) : undefined
      )
    );
    deadLettered += 1;
  }

  if (outcome.attempts > 1) {
    logger.warn(
      {
        attempts: outcome.attempts,
        committed: outcome.succeeded.length,
        deadLettered: outcome.failed.length,
      },
      'Click batch bisected to isolate failing events'
    );
  }

  return { flushed: outcome.succeeded.length, deadLettered };
}

/**
 * A dead-letter entry is an envelope, not a bare payload.
 *
 * The payload alone tells an operator what failed but not why, nor how many
 * times it has been tried -- so there is no way to decide between fixing the
 * cause and giving up on the message.
 */
export interface DeadLetterEnvelope {
  payload: unknown;
  reason: string;
  attempts: number;
  firstFailedAt: number;
  lastFailedAt: number;
}

async function deadLetter(raw: string, reason: string, previous?: DeadLetterEnvelope) {
  const now = Date.now();
  const envelope: DeadLetterEnvelope = {
    payload: previous ? previous.payload : safeParse(raw),
    reason,
    attempts: (previous?.attempts ?? 0) + 1,
    firstFailedAt: previous?.firstFailedAt ?? now,
    lastFailedAt: now,
  };

  const target = envelope.attempts >= MAX_ATTEMPTS ? PARKED_KEY : DLQ_KEY;
  if (target === PARKED_KEY) {
    logger.error(
      { reason, attempts: envelope.attempts },
      'Click event parked after repeated failures; it will not be retried again'
    );
  }

  await redis.lpush(target, JSON.stringify(envelope)).catch((err) => {
    logger.error({ err, reason }, 'Could not write a failed click event to the dead-letter queue');
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Recognises a dead-letter envelope, so a replayed message keeps its history. */
function asEnvelope(value: unknown): DeadLetterEnvelope | null {
  if (
    value &&
    typeof value === 'object' &&
    'payload' in value &&
    'attempts' in value &&
    typeof (value as DeadLetterEnvelope).attempts === 'number'
  ) {
    return value as DeadLetterEnvelope;
  }
  return null;
}

/**
 * Turns a queued payload into the row it becomes.
 *
 * Split out from the write so the transaction contains no CPU work. Parsing a
 * user agent is not free, and doing a hundred of them *inside* a transaction
 * holds its connection and its locks for the whole parse -- a cost paid by
 * every other writer, for work that touches no rows.
 */
function toRow(e: ClickEventPayload) {
  // Recomputed when the producer did not say, so a payload from an older
  // redirect deploy -- or from anything else writing to this queue -- is still
  // classified rather than defaulting to "human".
  const trafficKind = parseTrafficKind(e.trafficKind) ?? classifyTraffic(e.userAgent);
  const isCounted = e.isCounted ?? countsAsClick(trafficKind);
  const ua = new UAParser(e.userAgent);

  return {
    trackingLinkId: e.trackingLinkId,
    timestamp: new Date(e.timestamp),
    ipHash: e.ip,
    userAgent: e.userAgent,
    referrer: e.referrer || null,
    deviceType: ua.getDevice().type ?? 'desktop',
    browser: ua.getBrowser().name ?? null,
    os: ua.getOS().name ?? null,
    attributionCookieId: e.cookieId,
    trafficKind,
    isCounted,
    // Capped again here, not only at the redirect edge.
    //
    // The edge is where the caps belong for latency reasons, but this worker
    // consumes a Redis list -- it does not know who wrote to it, and "the
    // producer already validated this" is exactly the assumption that stops
    // being true when a second producer appears. Enforcing it where the data
    // is stored is what actually bounds the column.
    subIds: cappedSubIds(e.subIds),

    // The end of the trail. From here a single id joins the redirect log line,
    // the worker log line and this row, which is what makes "was this click
    // ever recorded?" a query rather than an argument.
    requestId: restoreRequestId(e) ?? null,
  };
}

/**
 * Writes one slice of the queue, all or nothing.
 *
 * The all-or-nothing part is not decoration. `bisectCommit` retries *halves*
 * of a slice that failed, so anything this function applied before throwing
 * would be applied again -- duplicate clicks, double-counted counters, and no
 * error anywhere. One transaction containing one `createMany` is what makes
 * bisection safe.
 *
 * It used to be one `INSERT` per event inside that transaction: a hundred
 * round trips to write a hundred rows, each a full request and response over
 * the socket with the transaction sat open the whole time. `createMany` sends
 * them as a single multi-row `INSERT`. Nothing about the rows changed; only
 * how many times we asked Postgres for something.
 */
async function flushBatch(events: ClickEventPayload[]) {
  const rows = events.map(toRow);

  // Only counted clicks move the denormalised counter. The row is written
  // either way, so filtered traffic stays visible in the table while staying
  // out of the numbers.
  const linkCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.isCounted) continue;
    linkCounts.set(row.trackingLinkId, (linkCounts.get(row.trackingLinkId) ?? 0) + 1);
  }

  // Sorted, so that two workers flushing overlapping batches take their row
  // locks on TrackingLink in the same order. Unordered updates from concurrent
  // transactions are the textbook deadlock, and it would show up as an
  // occasional failed batch rather than as anything obviously lock-shaped.
  const counters = [...linkCounts].sort(([a], [b]) => (a < b ? -1 : 1));

  await prisma.$transaction(async (tx) => {
    await tx.clickEvent.createMany({ data: rows });

    // Still one statement per *distinct link*, not per event: 100 clicks
    // across 4 links cost 5 statements rather than 104. Collapsing these into
    // a single `UPDATE ... FROM (VALUES ...)` would save three more round
    // trips and give up the lock ordering above, which is a bad trade at this
    // size.
    for (const [linkId, count] of counters) {
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
export async function replayDeadLetters(
  limit = 1000
): Promise<{ replayed: number; parked: number }> {
  let replayed = 0;
  let parked = 0;

  for (let i = 0; i < limit; i++) {
    const raw = await redis.rpop(DLQ_KEY);
    if (!raw) break;

    const envelope = asEnvelope(safeParse(raw));

    // A message that has already burned its attempts goes to the parked list
    // instead of back onto the queue. Replaying it forever is how one bad
    // event holds up the pipeline indefinitely -- which is exactly what the
    // previous version did, since it put the payload straight back with no
    // memory of having tried.
    if (envelope && envelope.attempts >= MAX_ATTEMPTS) {
      await redis.lpush(PARKED_KEY, raw);
      parked += 1;
      continue;
    }

    // Requeued as the envelope, not the bare payload, so the attempt count
    // survives the round trip. `drainClickEvents` unwraps it.
    await redis.lpush(QUEUE_KEY, raw);
    replayed += 1;
  }

  if (parked > 0) {
    logger.warn(
      { parked },
      'Dead-lettered click events parked instead of replayed; they have failed too often'
    );
  }

  return { replayed, parked };
}

/** Queue depths, for the admin health page. */
export async function queueDepths() {
  const [pending, dead, parkedCount] = await Promise.all([
    redis.llen(QUEUE_KEY),
    redis.llen(DLQ_KEY),
    redis.llen(PARKED_KEY),
  ]);
  return { pending, dead, parked: parkedCount };
}

/**
 * Deliberately **not** under a scheduler lease, unlike the other two workers.
 *
 * The distinction is worth understanding, because "we scaled out, so guard
 * everything" is the wrong lesson. A lease is needed when a job *reads a set
 * of rows and then acts on them*: two instances select the same set and both
 * act. This worker does not do that. It consumes a Redis list with RPOP, which
 * is atomic -- each event is handed to exactly one consumer, so N instances
 * simply share the queue and drain it N times faster.
 *
 * Putting a lease on it would make the extra instances idle and turn a
 * horizontally scalable consumer into a single-threaded one.
 */
export async function startClickEventWorker() {
  logger.info('Click event worker started');

  const tick = async () => {
    try {
      const { flushed, deadLettered } = await drainClickEvents();
      if (flushed > 0) logger.debug({ count: flushed }, 'Click events flushed');
      await beat(WORKER_NAME, BATCH_INTERVAL_MS, { lastFlushed: flushed, deadLettered });
    } catch (err) {
      // Reaching here is now rare: a failing batch is bisected and only the
      // individual bad events are dead-lettered, so this is for something
      // wider -- Redis or Postgres being unreachable.
      logger.error({ err }, 'Click event drain failed');
      // Still a beat: the worker is alive and failing, which is a different
      // state from absent, and the health page needs to tell them apart.
      await beat(WORKER_NAME, BATCH_INTERVAL_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Worker tick failed'));
  }, BATCH_INTERVAL_MS);
}
