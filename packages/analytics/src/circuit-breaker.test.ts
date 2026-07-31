import { describe, expect, it } from 'vitest';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  CLOSED_BREAKER,
  admit,
  onFailure,
  onSuccess,
  type BreakerSnapshot,
} from './circuit-breaker';

const T0 = 1_700_000_000_000;

/** Applies `n` consecutive failures to a fresh breaker. */
function afterFailures(n: number, now = T0): BreakerSnapshot {
  let snapshot = CLOSED_BREAKER;
  for (let i = 0; i < n; i++) snapshot = onFailure(snapshot, now);
  return snapshot;
}

describe('a closed breaker', () => {
  it('admits everything', () => {
    const decision = admit(CLOSED_BREAKER, T0);
    expect(decision.allow).toBe(true);
    expect(decision.next).toEqual(CLOSED_BREAKER);
  });

  it('stays closed short of the threshold', () => {
    const snapshot = afterFailures(BREAKER_FAILURE_THRESHOLD - 1);
    expect(snapshot.state).toBe('CLOSED');
    expect(snapshot.consecutiveFailures).toBe(BREAKER_FAILURE_THRESHOLD - 1);
    expect(admit(snapshot, T0).allow).toBe(true);
  });

  it('resets its failure count on any success', () => {
    // "Consecutive" is the whole point. An endpoint that fails four times an
    // hour and succeeds in between is flaky, not down, and tripping on it
    // would take a working integration offline.
    const snapshot = onSuccess(afterFailures(BREAKER_FAILURE_THRESHOLD - 1));
    expect(snapshot).toEqual(CLOSED_BREAKER);
  });

  it('opens on the fifth consecutive failure, not the fourth', () => {
    expect(afterFailures(4).state).toBe('CLOSED');
    const open = afterFailures(5);
    expect(open.state).toBe('OPEN');
    expect(open.openedAt).toBe(T0);
  });
});

describe('an open breaker', () => {
  it('refuses everything during the cooldown', () => {
    const snapshot = afterFailures(BREAKER_FAILURE_THRESHOLD);
    const decision = admit(snapshot, T0 + BREAKER_COOLDOWN_MS - 1);

    expect(decision.allow).toBe(false);
    expect(decision.next).toEqual(snapshot);
    expect(decision.retryAt).toBe(T0 + BREAKER_COOLDOWN_MS);
  });

  it('admits a probe once the cooldown has elapsed', () => {
    const decision = admit(
      afterFailures(BREAKER_FAILURE_THRESHOLD),
      T0 + BREAKER_COOLDOWN_MS
    );

    expect(decision.allow).toBe(true);
    expect(decision.next.state).toBe('HALF_OPEN');
  });
});

describe('a half-open breaker', () => {
  const probing = admit(
    afterFailures(BREAKER_FAILURE_THRESHOLD),
    T0 + BREAKER_COOLDOWN_MS
  ).next;

  it('lets exactly one probe through', () => {
    // The state changes on admission rather than on the result, so the
    // deliveries queued behind the probe find the door shut. Without this,
    // every delivery for a recovering endpoint is admitted at once and the
    // "probe" is however many are pending.
    const second = admit(probing, T0 + BREAKER_COOLDOWN_MS + 1);
    expect(second.allow).toBe(false);
  });

  it('closes when the probe succeeds', () => {
    expect(onSuccess(probing)).toEqual(CLOSED_BREAKER);
  });

  it('reopens on a failed probe without waiting for another five', () => {
    const now = T0 + BREAKER_COOLDOWN_MS + 500;
    const reopened = onFailure(probing, now);

    expect(reopened.state).toBe('OPEN');
    expect(reopened.openedAt).toBe(now);
    expect(admit(reopened, now + 1).allow).toBe(false);
  });

  it('probes again after a further cooldown if a probe is lost', () => {
    // A worker killed between admitting a probe and recording its result
    // leaves the breaker half-open with nothing in flight. Without this the
    // endpoint is refused forever, with no failure recorded and no event that
    // could ever recover it.
    const decision = admit(probing, T0 + BREAKER_COOLDOWN_MS * 2 + 1);
    expect(decision.allow).toBe(true);
    expect(decision.next.state).toBe('HALF_OPEN');
  });
});

describe('a breaker with missing state', () => {
  it('treats an open breaker with no openedAt as opening now', () => {
    // Defensive: the column is nullable because a closed breaker has no
    // opened-at, so a hand-edited or half-migrated row can present this. It
    // must not read as "opened at the epoch", which would admit immediately
    // and defeat the cooldown.
    const decision = admit(
      { state: 'OPEN', consecutiveFailures: 9, openedAt: null },
      T0
    );
    expect(decision.allow).toBe(false);
    expect(decision.retryAt).toBe(T0 + BREAKER_COOLDOWN_MS);
  });
});
