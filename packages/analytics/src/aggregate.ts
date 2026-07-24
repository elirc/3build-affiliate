import { parseISO } from 'date-fns';
import type { DailyMetric } from '@affiliate/shared';

export interface RawClickRow {
  date: string;
  count: number;
}
export interface RawConversionRow {
  date: string;
  count: number;
  revenue: number;
  commission: number;
}

/**
 * Fill in days with zeros so charts don't have gaps when a day has no events.
 */
export function buildDailySeries(
  start: Date,
  end: Date,
  clicks: RawClickRow[],
  conversions: RawConversionRow[]
): DailyMetric[] {
  const clickMap = new Map(clicks.map((c) => [c.date, c.count]));
  const convMap = new Map(conversions.map((c) => [c.date, c]));
  return eachUtcDay(start, end).map((key) => {
    const conv = convMap.get(key);
    return {
      date: key,
      clicks: clickMap.get(key) ?? 0,
      conversions: conv?.count ?? 0,
      revenue: (conv?.revenue ?? 0).toFixed(2),
      commission: (conv?.commission ?? 0).toFixed(2),
    };
  });
}

function eachUtcDay(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  for (let ts = cursor; ts <= endDay; ts += 86400 * 1000) {
    keys.push(new Date(ts).toISOString().slice(0, 10));
  }

  return keys;
}

export function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function epc(totalCommission: number, totalClicks: number): string {
  if (totalClicks <= 0) return '0.00';
  return (totalCommission / totalClicks).toFixed(2);
}

export function parseDate(iso: string): Date {
  return parseISO(iso);
}
