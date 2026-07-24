import { describe, expect, it } from 'vitest';
import { buildDailySeries, epc, safeRate } from './aggregate';

describe('buildDailySeries', () => {
  it('fills missing days and merges click and conversion rows', () => {
    const series = buildDailySeries(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
      [
        { date: '2026-01-01', count: 5 },
        { date: '2026-01-03', count: 2 },
      ],
      [
        { date: '2026-01-02', count: 1, revenue: 99.5, commission: 14.925 },
      ]
    );

    expect(series).toEqual([
      {
        date: '2026-01-01',
        clicks: 5,
        conversions: 0,
        revenue: '0.00',
        commission: '0.00',
      },
      {
        date: '2026-01-02',
        clicks: 0,
        conversions: 1,
        revenue: '99.50',
        commission: '14.93',
      },
      {
        date: '2026-01-03',
        clicks: 2,
        conversions: 0,
        revenue: '0.00',
        commission: '0.00',
      },
    ]);
  });
});

describe('aggregate ratios', () => {
  it('returns zero for empty denominators', () => {
    expect(safeRate(3, 0)).toBe(0);
    expect(epc(25, 0)).toBe('0.00');
  });

  it('formats conversion rate and earnings per click', () => {
    expect(safeRate(3, 40)).toBe(7.5);
    expect(epc(25, 40)).toBe('0.63');
  });
});
