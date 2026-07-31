/**
 * The circuit breaker for one webhook endpoint.
 *
 * Retries alone are not enough. A subscriber whose endpoint has been dead for
 * a day still has every delivery in its queue attempted, each one holding a
 * worker slot for up to the request timeout. Ten slots and one dead endpoint
 * is the whole delivery pipeline spent on requests that cannot succeed, while
 * healthy subscribers wait behind them. The breaker is what stops one broken
 * integration from becoming everyone's outage.
 *
 * ```text
 *    CLOSED ──5 consecutive failures──► OPEN ──cooldown 60s──► HALF_OPEN
 *       ▲                                                          │
 *       └────────────── one probe succeeds ────────────────────────┘
 *                       probe fails ⇒ back to OPEN
 * ```
 *
 * Pure: the state is passed in and the next state is returned, with `now` as
 * an argument rather than a call to the clock. The database owns the storage
 * and the worker owns the I/O; this file owns only the rule, which is the part
 * with the edge cases.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Consecutive failures that trip a closed breaker. */
export const BREAKER_FAILURE_THRESHOLD = 5;

/** How long an open breaker refuses everything before it will probe. */
export const BREAKER_COOLDOWN_MS = 60_000;

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  /** When the breaker last refused traffic. Null whenever it is closed. */
  openedAt: number | null;
}

export const CLOSED_BREAKER: BreakerSnapshot = {
  state: 'CLOSED',
  consecutiveFailures: 0,
  openedAt: null,
};

export interface BreakerDecision {
  allow: boolean;
  /**
   * The snapshot to persist *before* the attempt is made.
   *
   * Admitting a probe is itself a state change -- it is what makes the probe
   * the only one -- so the caller has to write it back even though nothing has
   * been delivered yet.
   */
  next: BreakerSnapshot;
  /** When it is worth asking again. Null when the answer is yes. */
  retryAt: number | null;
}

/**
 * Decides whether one delivery may be attempted right now.
 *
 * The half-open case is the interesting one and the one people get wrong: the
 * state has to change *on admission*, not on the result, or every queued
 * delivery for a recovering endpoint is admitted at once and the "one probe"
 * is a thousand.
 */
export function admit(
  snapshot: BreakerSnapshot,
  now: number,
  cooldownMs = BREAKER_COOLDOWN_MS
): BreakerDecision {
  if (snapshot.state === 'CLOSED') {
    return { allow: true, next: snapshot, retryAt: null };
  }

  const openedAt = snapshot.openedAt ?? now;
  const elapsed = now - openedAt;

  if (elapsed < cooldownMs) {
    return { allow: false, next: snapshot, retryAt: openedAt + cooldownMs };
  }

  // Both OPEN and HALF_OPEN end up here once the cooldown has elapsed, and
  // that is deliberate. A HALF_OPEN breaker whose probe never returned -- the
  // worker was killed between admitting it and recording the result -- would
  // otherwise refuse the endpoint forever, with no failure recorded and no
  // event to recover from. Stamping `openedAt` on admission means a lost probe
  // costs one more cooldown rather than the endpoint.
  return {
    allow: true,
    next: { ...snapshot, state: 'HALF_OPEN', openedAt: now },
    retryAt: null,
  };
}

/**
 * Records a delivery that succeeded.
 *
 * Any success closes the breaker, including one that arrives while it is open
 * -- a delivery admitted just before the breaker tripped can land afterwards,
 * and the endpoint is evidently alive.
 */
export function onSuccess(_snapshot: BreakerSnapshot): BreakerSnapshot {
  return CLOSED_BREAKER;
}

/**
 * Records a delivery that failed.
 *
 * A failed probe goes straight back to OPEN without waiting for another five
 * failures. The endpoint has just told us it is still down; spending four more
 * requests to confirm that is the cost the breaker exists to avoid.
 */
export function onFailure(
  snapshot: BreakerSnapshot,
  now: number,
  threshold = BREAKER_FAILURE_THRESHOLD
): BreakerSnapshot {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;

  if (snapshot.state === 'HALF_OPEN') {
    return { state: 'OPEN', consecutiveFailures, openedAt: now };
  }

  if (consecutiveFailures >= threshold) {
    return { state: 'OPEN', consecutiveFailures, openedAt: now };
  }

  return { state: 'CLOSED', consecutiveFailures, openedAt: null };
}
