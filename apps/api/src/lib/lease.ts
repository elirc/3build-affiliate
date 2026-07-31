import { redis } from '../config/redis';
import { logger } from './logger';
import { env } from '../config/env';

/**
 * Run a job on exactly one instance at a time.
 *
 * Every API process starts its own `setInterval` workers, so running two
 * instances -- the ordinary way to get availability -- runs every scheduled
 * job twice per tick. For the click worker that is harmless, because RPOP is
 * atomic and two consumers just share the list. For anything that *reads a set
 * of rows and then acts on them* it is not: both instances select the same
 * rows and both act.
 *
 * ## Why a lease rather than a lock
 *
 * A lock held by a process that has crashed is never released, and the job
 * stops forever. So the thing you actually want is a lock with an expiry -- a
 * lease -- renewed by the holder while it works. A crash then costs you one
 * TTL of delay instead of an outage that needs a human.
 *
 * ## Why release is not DEL
 *
 * The subtle failure. If your lease expires mid-job and another instance
 * acquires it, a plain `DEL` at the end of your work deletes *their* lease --
 * and now a third instance can take it while the second is still running, so
 * you have two holders and no lock at all. Release must therefore be a
 * compare-and-delete: remove the key only if it still holds *my* id, checked
 * and executed atomically. Redis runs a Lua script atomically, which is why
 * this is Lua and not two commands.
 */

/** Delete the key only if it still holds our value. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Extend the TTL only if we still hold it. Same reasoning as release. */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

const key = (name: string) => `scheduler:lease:${name}`;

export interface LeaseResult<T> {
  /** False means another instance held the lease; `fn` was never called. */
  ran: boolean;
  value?: T;
}

/**
 * Who we are. Stable for the life of the process, and written into the lease
 * so that release and renewal can tell our lease from someone else's.
 */
export const INSTANCE_ID = env.INSTANCE_ID;

export async function readLeaseHolder(name: string): Promise<string | null> {
  try {
    return await redis.get(key(name));
  } catch {
    return null;
  }
}

/**
 * Acquires `name` for `ttlMs`, runs `fn`, and releases.
 *
 * `fn` receives an `AbortSignal` that fires if the lease is lost while it is
 * still working. Losing a lease is not something to swallow: it means another
 * instance may already be running the same job, so the work in flight is no
 * longer protected and needs to know.
 */
export async function withLease<T>(
  name: string,
  ttlMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<LeaseResult<T>> {
  const k = key(name);

  // SET ... NX PX is the acquisition: set only if absent, with an expiry, in
  // one round trip. Doing it as EXISTS-then-SET would be the same check-then-
  // act race this whole module exists to prevent.
  const acquired = await redis.set(k, INSTANCE_ID, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return { ran: false };

  const controller = new AbortController();

  // Renew at a third of the TTL: often enough that two consecutive failures
  // still leave a window to recover, rare enough not to be chatty.
  const renewEvery = Math.max(1000, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    redis
      .eval(RENEW_SCRIPT, 1, k, INSTANCE_ID, String(ttlMs))
      .then((result) => {
        if (result === 0 && !controller.signal.aborted) {
          // We no longer hold it. Someone else may be running this job now.
          logger.error(
            { lease: name, instanceId: INSTANCE_ID },
            'Lease lost while the job was still running'
          );
          controller.abort();
        }
      })
      .catch((err) => {
        logger.warn({ err, lease: name }, 'Lease renewal failed');
      });
  }, renewEvery);

  try {
    const value = await fn(controller.signal);
    return { ran: true, value };
  } finally {
    // `finally`, so a throwing job still releases rather than holding the
    // lease until it expires and stalling the next tick.
    clearInterval(timer);
    try {
      await redis.eval(RELEASE_SCRIPT, 1, k, INSTANCE_ID);
    } catch (err) {
      // Not fatal: the TTL will clear it. Worth a line, because a release that
      // keeps failing means every tick waits out the full TTL.
      logger.warn({ err, lease: name }, 'Lease release failed; falling back to TTL');
    }
  }
}
