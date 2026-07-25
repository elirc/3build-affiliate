import { redis } from '../config/redis';
import { logger } from './logger';

/**
 * Worker liveness.
 *
 * A heartbeat with a TTL, rather than a "last run" timestamp in a table. The
 * difference matters: a timestamp column shows "last seen three days ago"
 * forever, which is indistinguishable from a worker that ran three days ago
 * and then stopped. A key that expires is simply absent, and absent is
 * unambiguous.
 */

export interface Heartbeat {
  at: number;
  detail?: Record<string, unknown>;
}

const KEY = (worker: string) => `heartbeat:${worker}`;

/**
 * TTL is a multiple of the worker's own interval, so a single slow tick does
 * not read as a dead worker while a genuinely stopped one still expires
 * promptly.
 */
export async function beat(
  worker: string,
  intervalMs: number,
  detail?: Record<string, unknown>
) {
  const ttlSeconds = Math.max(5, Math.ceil((intervalMs * 3) / 1000));
  try {
    await redis.set(
      KEY(worker),
      JSON.stringify({ at: Date.now(), detail } satisfies Heartbeat),
      'EX',
      ttlSeconds
    );
  } catch (err) {
    // A worker must never fail because it could not report that it is alive.
    logger.warn({ err, worker }, 'Failed to write heartbeat');
  }
}

export async function readHeartbeat(worker: string): Promise<Heartbeat | null> {
  try {
    const raw = await redis.get(KEY(worker));
    return raw ? (JSON.parse(raw) as Heartbeat) : null;
  } catch {
    return null;
  }
}
