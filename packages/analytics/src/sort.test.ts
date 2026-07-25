import { describe, expect, it } from 'vitest';
import { resolveSort } from './sort';

const spec = {
  columns: {
    clicks: 'total_clicks',
    revenue: 'total_revenue',
    epc: 'epc',
  },
  defaultKey: 'revenue' as const,
};

describe('resolveSort', () => {
  it('maps a known key to its column', () => {
    expect(resolveSort(spec, 'clicks', 'asc')).toEqual({
      column: 'total_clicks',
      direction: 'ASC',
      key: 'clicks',
    });
  });

  it('falls back to the default for an unknown key', () => {
    expect(resolveSort(spec, 'nonsense', undefined).key).toBe('revenue');
  });

  it('never lets a client string reach SQL', () => {
    // The whole point. A column name cannot be a bind parameter, which is why
    // people interpolate it and why this map exists instead.
    const attacks = [
      'clicks; DROP TABLE "User"; --',
      '(SELECT pg_sleep(10))',
      'total_clicks',           // a real column name, still not a valid *key*
      "clicks' OR '1'='1",
      '1',
    ];

    for (const attack of attacks) {
      const resolved = resolveSort(spec, attack, 'desc');
      expect(Object.values(spec.columns), attack).toContain(resolved.column);
    }
  });

  it('only ever emits ASC or DESC', () => {
    for (const bad of ['asc; DROP TABLE x', 'ASC', 'sideways', '', undefined]) {
      expect(['ASC', 'DESC']).toContain(resolveSort(spec, 'clicks', bad).direction);
    }
  });

  it('defaults direction to descending', () => {
    // Performance tables are read to find the best and the worst, and the
    // best is what people look for first.
    expect(resolveSort(spec, 'clicks', undefined).direction).toBe('DESC');
  });

  it('honours an explicit ascending default', () => {
    expect(
      resolveSort({ ...spec, defaultDirection: 'asc' }, 'clicks', undefined).direction
    ).toBe('ASC');
  });
});
