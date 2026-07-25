/**
 * Date ranges and period-over-period comparison.
 *
 * Everything here is UTC, matching `eachUtcDay` in aggregate.ts. Mixing a
 * local-time range with UTC bucketing produces a series whose first and last
 * days are partial, which reads as a sudden dip at both ends of every chart --
 * and it is the sort of bug people explain away as "traffic patterns".
 */

export interface DateRange {
  start: Date;
  end: Date;
}

export const MAX_RANGE_DAYS = 365;

/**
 * The immediately preceding window of the same length.
 *
 * Ends one millisecond before the current window starts, so the two never
 * overlap. Sharing a boundary instant would double-count anything landing on
 * it -- rare, and the sort of off-by-one that produces a permanently wrong
 * comparison nobody can reproduce.
 */
export function previousPeriod(range: DateRange): DateRange {
  const span = range.end.getTime() - range.start.getTime();
  return {
    start: new Date(range.start.getTime() - span - 1),
    end: new Date(range.start.getTime() - 1),
  };
}

export function rangeFromDays(days: number, now = new Date()): DateRange {
  return { start: new Date(now.getTime() - days * 86400 * 1000), end: now };
}

export type RangeError =
  | 'end_before_start'
  | 'range_too_long'
  | 'start_in_future';

export type RangeResult =
  | { ok: true; range: DateRange }
  | { ok: false; reason: RangeError };

/**
 * Validates an explicit from/to range.
 *
 * Bounded because these feed unindexed-by-range aggregate queries; an
 * unbounded range is a way for anyone to make the database do arbitrary work.
 */
export function resolveRange(
  from: Date | undefined,
  to: Date | undefined,
  now = new Date()
): RangeResult {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - 30 * 86400 * 1000);

  // Order matters. A caller who supplies only a future `from` gets an implied
  // `end` of now, which is also "end before start" -- but telling them their
  // start date is in the future is the answer they can act on. The more
  // specific diagnosis goes first.
  if (start.getTime() > now.getTime()) return { ok: false, reason: 'start_in_future' };
  if (end.getTime() < start.getTime()) return { ok: false, reason: 'end_before_start' };

  const days = (end.getTime() - start.getTime()) / 86400 / 1000;
  if (days > MAX_RANGE_DAYS) return { ok: false, reason: 'range_too_long' };

  return { ok: true, range: { start, end } };
}

export type Direction = 'up' | 'down' | 'flat' | 'new';

export interface Comparison {
  current: number;
  previous: number;
  /** Null when there is no meaningful percentage -- see `direction: 'new'`. */
  changePercent: number | null;
  direction: Direction;
}

/**
 * Compares two periods.
 *
 * Growth from zero has no percentage: any increase from nothing is infinite,
 * and rendering "∞%" or "100%" are both lies. `direction: 'new'` with a null
 * percentage lets the UI say "new" and mean it.
 */
export function comparePeriods(current: number, previous: number): Comparison {
  if (previous === 0) {
    return {
      current,
      previous,
      changePercent: null,
      direction: current === 0 ? 'flat' : 'new',
    };
  }

  const changePercent = Math.round(((current - previous) / previous) * 1000) / 10;

  return {
    current,
    previous,
    changePercent,
    direction: changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat',
  };
}

/**
 * Whether an increase in this metric is good news.
 *
 * Needed because the UI must not colour by direction alone: a rise in clicks
 * is good, a rise in refunds is not, and a chart that paints both green is
 * actively misleading.
 */
export function higherIsBetter(metric: string): boolean {
  return !['refunds', 'clawbacks', 'rejections'].includes(metric);
}
