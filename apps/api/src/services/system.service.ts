import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { readHeartbeat } from '../lib/heartbeat';
import { INSTANCE_ID, readLeaseHolder } from '../lib/lease';
import {
  DLQ_KEY,
  QUEUE_KEY,
  WORKER_NAME as CLICK_WORKER,
} from '../workers/click-event.worker';
import { WORKER_NAME as LOCK_WORKER } from '../workers/lock-expiry.worker';
import { WORKER_NAME as NOTIFICATION_WORKER } from '../workers/notification.worker';

/**
 * Operational health, in one place.
 *
 * The point is to make silent failures visible. The click pipeline in
 * particular can be completely broken while every user-facing page looks
 * perfectly normal -- clicks pile up in Redis, conversions report "no
 * attributable clicks", and nothing anywhere says why.
 */

export type Health = 'healthy' | 'degraded' | 'down';

export interface Check {
  name: string;
  status: Health;
  /** Written for whoever is woken up by it, not for whoever wrote it. */
  detail: string;
  value?: number | string | null;
}

/** Queue depth thresholds. At 1/s drain, 10k is ~3 hours behind. */
const QUEUE_DEGRADED = 10_000;
const QUEUE_DOWN = 50_000;

/**
 * Expensive counts are cached briefly.
 *
 * The page auto-refreshes every 15 seconds, and a health check that puts a
 * meaningful load on the database is a health check that eventually causes
 * the incident it was meant to detect.
 */
const CACHE_MS = 10_000;
let cache: { at: number; value: Check[] } | null = null;

export function systemService() {
  async function redisChecks(): Promise<Check[]> {
    try {
      const [queueDepth, dlqDepth] = await Promise.all([
        redis.llen(QUEUE_KEY),
        redis.llen(DLQ_KEY),
      ]);

      const queueStatus: Health =
        queueDepth >= QUEUE_DOWN
          ? 'down'
          : queueDepth >= QUEUE_DEGRADED
            ? 'degraded'
            : 'healthy';

      return [
        {
          name: 'Redis',
          status: 'healthy',
          detail: 'Reachable.',
        },
        {
          name: 'Click queue',
          status: queueStatus,
          value: queueDepth,
          detail:
            queueStatus === 'healthy'
              ? `${queueDepth} click(s) waiting to be written.`
              : `${queueDepth} clicks are backed up. The click worker is not ` +
                `keeping up, or has stopped. Attribution will start failing.`,
        },
        {
          name: 'Dead-letter queue',
          status: dlqDepth > 0 ? 'degraded' : 'healthy',
          value: dlqDepth,
          detail:
            dlqDepth > 0
              ? `${dlqDepth} click(s) failed to write and are held for replay. ` +
                `Fix the cause, then replay them.`
              : 'Empty.',
        },
      ];
    } catch (err) {
      return [
        {
          name: 'Redis',
          status: 'down',
          detail:
            'Unreachable. Redirects still serve cached links, but new clicks ' +
            `are being lost. (${String(err)})`,
        },
      ];
    }
  }

  async function databaseCheck(): Promise<Check> {
    const started = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      const ms = Date.now() - started;
      return {
        name: 'Database',
        status: ms > 1000 ? 'degraded' : 'healthy',
        value: ms,
        detail: `Round trip ${ms}ms.`,
      };
    } catch (err) {
      return {
        name: 'Database',
        status: 'down',
        detail: `Unreachable. (${String(err)})`,
      };
    }
  }

  async function workerCheck(
    worker: string,
    label: string,
    expectedIntervalMs: number
  ): Promise<Check> {
    const [hb, leaseHolder] = await Promise.all([
      readHeartbeat(worker),
      readLeaseHolder(worker),
    ]);

    if (!hb) {
      return {
        name: label,
        status: 'down',
        detail:
          'No heartbeat. The worker has stopped, or was never started ' +
          '(check DISABLE_WORKERS).',
      };
    }

    const age = Date.now() - hb.at;
    const lastError = hb.detail?.lastError;

    if (lastError) {
      return {
        name: label,
        status: 'degraded',
        value: age,
        detail: `Running but failing: ${String(lastError)}`,
      };
    }

    // A worker that keeps reporting "lease held elsewhere" is healthy on this
    // instance and doing exactly the right thing -- but an operator looking at
    // one instance needs to be told that, or an idle worker reads as a broken
    // one.
    if (hb.detail?.skipped) {
      return {
        name: label,
        status: 'healthy',
        value: age,
        detail: `Standby; another instance holds the lease${
          leaseHolder ? ` (${leaseHolder})` : ''
        }.`,
      };
    }

    return {
      name: label,
      status: age > expectedIntervalMs * 3 ? 'degraded' : 'healthy',
      value: age,
      detail: `Last ran ${Math.round(age / 1000)}s ago.`,
    };
  }

  /**
   * Domain counters that mean somebody needs to do something.
   *
   * Bounded queries only -- no unqualified COUNT(*) over ClickEvent, which is
   * the one table large enough to make this endpoint the problem.
   */
  async function domainChecks(): Promise<Check[]> {
    const weekAgo = new Date(Date.now() - 7 * 86400 * 1000);
    const dayAgo = new Date(Date.now() - 86400 * 1000);

    const [pendingFraud, staleConversions, stuckPayouts] = await Promise.all([
      prisma.fraudReview.count({ where: { decision: 'PENDING' } }),
      prisma.conversion.count({
        where: { status: 'PENDING', occurredAt: { lt: weekAgo } },
      }),
      prisma.payout.count({
        where: { status: 'PROCESSING', createdAt: { lt: dayAgo } },
      }),
    ]);

    return [
      {
        name: 'Fraud queue',
        status: pendingFraud > 50 ? 'degraded' : 'healthy',
        value: pendingFraud,
        detail: `${pendingFraud} review(s) awaiting a decision.`,
      },
      {
        name: 'Stale conversions',
        status: staleConversions > 0 ? 'degraded' : 'healthy',
        value: staleConversions,
        detail:
          staleConversions > 0
            ? `${staleConversions} conversion(s) have been awaiting brand review ` +
              `for over a week. Affiliates are not being paid for them.`
            : 'None older than a week.',
      },
      {
        name: 'Stuck payouts',
        status: stuckPayouts > 0 ? 'degraded' : 'healthy',
        value: stuckPayouts,
        detail:
          stuckPayouts > 0
            ? `${stuckPayouts} payout(s) have been processing for over a day. ` +
              `Either the transfer succeeded and was never marked paid, or it failed.`
            : 'None stuck.',
      },
    ];
  }

  return {
    async check(): Promise<{
      status: Health;
      checks: Check[];
      cachedFor: number;
      /** Which process answered. With more than one instance, "the worker is
       *  down" is only ever true of the one you happened to reach. */
      instanceId: string;
    }> {
      if (cache && Date.now() - cache.at < CACHE_MS) {
        return {
          status: worstOf(cache.value),
          checks: cache.value,
          cachedFor: CACHE_MS - (Date.now() - cache.at),
          instanceId: INSTANCE_ID,
        };
      }

      const checks = [
        await databaseCheck(),
        ...(await redisChecks()),
        await workerCheck(CLICK_WORKER, 'Click worker', 1_000),
        await workerCheck(LOCK_WORKER, 'Lock-expiry worker', 60_000),
        await workerCheck(NOTIFICATION_WORKER, 'Notification worker', 10_000),
        ...(await domainChecks()),
      ];

      cache = { at: Date.now(), value: checks };
      return { status: worstOf(checks), checks, cachedFor: CACHE_MS, instanceId: INSTANCE_ID };
    },

    /**
     * Who currently holds each scheduled job.
     *
     * Not cached: leadership is the thing you are watching move when you are
     * debugging why a job stopped, and a stale answer is worse than none.
     */
    async leases() {
      const names = [LOCK_WORKER, NOTIFICATION_WORKER];
      const holders = await Promise.all(names.map((n) => readLeaseHolder(n)));
      return {
        instanceId: INSTANCE_ID,
        leases: names.map((name, i) => ({
          name,
          holder: holders[i],
          self: holders[i] === INSTANCE_ID,
        })),
      };
    },

    /** Exposed so a test can start from a known state. */
    clearCache() {
      cache = null;
    },
  };
}

function worstOf(checks: Check[]): Health {
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'healthy';
}
