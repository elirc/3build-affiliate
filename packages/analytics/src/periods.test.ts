import { describe, expect, it } from 'vitest';
import {
  comparePeriods,
  higherIsBetter,
  MAX_RANGE_DAYS,
  previousPeriod,
  rangeFromDays,
  resolveRange,
} from './periods';

const NOW = new Date('2026-03-31T12:00:00.000Z');

describe('previousPeriod', () => {
  it('is the same length, immediately before', () => {
    const range = {
      start: new Date('2026-03-01T00:00:00.000Z'),
      end: new Date('2026-03-31T00:00:00.000Z'),
    };
    const prev = previousPeriod(range);

    expect(prev.end.getTime()).toBe(range.start.getTime() - 1);
    expect(prev.end.getTime() - prev.start.getTime()).toBe(
      range.end.getTime() - range.start.getTime()
    );
  });

  it('never overlaps the current period', () => {
    // Sharing a boundary instant double-counts anything landing on it --
    // rare, and a permanently wrong comparison nobody can reproduce.
    const range = rangeFromDays(7, NOW);
    const prev = previousPeriod(range);

    expect(prev.end.getTime()).toBeLessThan(range.start.getTime());
  });
});

describe('resolveRange', () => {
  it('defaults to the last 30 days', () => {
    const result = resolveRange(undefined, undefined, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const days =
      (result.range.end.getTime() - result.range.start.getTime()) / 86400 / 1000;
    expect(days).toBeCloseTo(30, 5);
  });

  it('accepts an explicit range', () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-03-15T00:00:00.000Z');
    const result = resolveRange(from, to, NOW);

    expect(result).toEqual({ ok: true, range: { start: from, end: to } });
  });

  it('rejects an end before the start', () => {
    expect(
      resolveRange(new Date('2026-03-15'), new Date('2026-03-01'), NOW)
    ).toEqual({ ok: false, reason: 'end_before_start' });
  });

  it('rejects a range longer than the cap', () => {
    // These feed aggregate queries. An unbounded range is a way for anyone to
    // make the database do arbitrary work.
    const from = new Date(NOW.getTime() - (MAX_RANGE_DAYS + 1) * 86400 * 1000);
    expect(resolveRange(from, NOW, NOW)).toEqual({
      ok: false,
      reason: 'range_too_long',
    });
  });

  it('accepts exactly the cap', () => {
    const from = new Date(NOW.getTime() - MAX_RANGE_DAYS * 86400 * 1000);
    expect(resolveRange(from, NOW, NOW).ok).toBe(true);
  });

  it('rejects a start in the future', () => {
    const from = new Date(NOW.getTime() + 86400 * 1000);
    expect(resolveRange(from, undefined, NOW)).toEqual({
      ok: false,
      reason: 'start_in_future',
    });
  });
});

describe('comparePeriods', () => {
  it('reports growth and decline', () => {
    expect(comparePeriods(150, 100)).toEqual({
      current: 150,
      previous: 100,
      changePercent: 50,
      direction: 'up',
    });

    expect(comparePeriods(75, 100)).toMatchObject({
      changePercent: -25,
      direction: 'down',
    });
  });

  it('reports growth from zero as "new", not as a percentage', () => {
    // Any increase from nothing is infinite. Rendering "∞%" or "100%" are
    // both lies; "new" is the truth.
    expect(comparePeriods(42, 0)).toEqual({
      current: 42,
      previous: 0,
      changePercent: null,
      direction: 'new',
    });
  });

  it('reports zero-to-zero as flat, not as new', () => {
    expect(comparePeriods(0, 0)).toMatchObject({
      changePercent: null,
      direction: 'flat',
    });
  });

  it('reports a drop to zero as -100%', () => {
    // This one *is* expressible, and it is the most important number on the
    // page when it happens.
    expect(comparePeriods(0, 80)).toMatchObject({
      changePercent: -100,
      direction: 'down',
    });
  });

  it('rounds to one decimal place', () => {
    expect(comparePeriods(101, 99).changePercent).toBe(2);
    expect(comparePeriods(1234, 1000).changePercent).toBe(23.4);
  });

  it('treats an unchanged value as flat', () => {
    expect(comparePeriods(100, 100).direction).toBe('flat');
  });
});

describe('higherIsBetter', () => {
  it('knows which metrics are good when they rise', () => {
    // The UI must not colour by direction alone: a rise in clicks is good, a
    // rise in refunds is not, and painting both green misleads.
    expect(higherIsBetter('clicks')).toBe(true);
    expect(higherIsBetter('revenue')).toBe(true);
    expect(higherIsBetter('refunds')).toBe(false);
    expect(higherIsBetter('clawbacks')).toBe(false);
  });
});
