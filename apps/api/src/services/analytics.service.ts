import {
  buildDailySeries,
  comparePeriods,
  epc,
  previousPeriod,
  safeRate,
  type DateRange,
} from '@affiliate/analytics';
import type { DailyMetric } from '@affiliate/shared';
import { prisma } from '../config/prisma';

type Scope = { brandId: string } | { affiliateId: string };

const DEFAULT_DAYS = 30;

/**
 * Daily click/conversion/revenue/commission series for a brand or an
 * affiliate. We pull two grouped queries (clicks via raw SQL because
 * `groupBy` on a derived date column isn't supported by Prisma's typed
 * query builder) and fill in zero-days client-side.
 */
export function analyticsService() {


  async function clicksByDay(scope: Scope, start: Date, end: Date) {
    if ('brandId' in scope) {
      return prisma.$queryRaw<{ date: string; count: bigint }[]>`
        SELECT to_char("timestamp", 'YYYY-MM-DD') as date, COUNT(*)::bigint as count
        FROM "ClickEvent" ce
        JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
        JOIN "Campaign" c ON c.id = tl."campaignId"
        WHERE c."brandId" = ${scope.brandId}
          AND ce."isCounted" = true
          AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
        GROUP BY 1 ORDER BY 1
      `;
    }
    return prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT to_char("timestamp", 'YYYY-MM-DD') as date, COUNT(*)::bigint as count
      FROM "ClickEvent" ce
      JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
      WHERE tl."affiliateId" = ${scope.affiliateId}
        AND ce."isCounted" = true
        AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
      GROUP BY 1 ORDER BY 1
    `;
  }

  async function conversionsByDay(scope: Scope, start: Date, end: Date) {
    if ('brandId' in scope) {
      return prisma.$queryRaw<
        { date: string; count: bigint; revenue: string; commission: string }[]
      >`
        SELECT to_char(co."occurredAt", 'YYYY-MM-DD') as date,
               COUNT(*)::bigint as count,
               COALESCE(SUM(co."conversionValue"),0)::text as revenue,
               COALESCE(SUM(co."commissionAmount"),0)::text as commission
        FROM "Conversion" co
        JOIN "Campaign" c ON c.id = co."campaignId"
        WHERE c."brandId" = ${scope.brandId}
          AND co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
        GROUP BY 1 ORDER BY 1
      `;
    }
    return prisma.$queryRaw<
      { date: string; count: bigint; revenue: string; commission: string }[]
    >`
      SELECT to_char(co."occurredAt", 'YYYY-MM-DD') as date,
             COUNT(*)::bigint as count,
             COALESCE(SUM(co."conversionValue"),0)::text as revenue,
             COALESCE(SUM(co."commissionAmount"),0)::text as commission
      FROM "Conversion" co
      WHERE co."affiliateId" = ${scope.affiliateId}
        AND co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
      GROUP BY 1 ORDER BY 1
    `;
  }

  /** The daily series for a window, plus its totals. */
  async function seriesFor(scope: Scope, window: DateRange) {
    const [clicks, convs] = await Promise.all([
      clicksByDay(scope, window.start, window.end),
      conversionsByDay(scope, window.start, window.end),
    ]);

    const series: DailyMetric[] = buildDailySeries(
      window.start,
      window.end,
      clicks.map((r) => ({ date: r.date, count: Number(r.count) })),
      convs.map((r) => ({
        date: r.date,
        count: Number(r.count),
        revenue: Number(r.revenue),
        commission: Number(r.commission),
      }))
    );

    return {
      series,
      clicks: series.reduce((s, d) => s + d.clicks, 0),
      conversions: series.reduce((s, d) => s + d.conversions, 0),
      revenue: series.reduce((s, d) => s + Number(d.revenue), 0),
      commission: series.reduce((s, d) => s + Number(d.commission), 0),
    };
  }

  async function buildResponse(scope: Scope, window: DateRange, compare: boolean) {
    const { start, end } = window;
    const [clicks, convs] = await Promise.all([
      clicksByDay(scope, start, end),
      conversionsByDay(scope, start, end),
    ]);
    const series: DailyMetric[] = buildDailySeries(
      start,
      end,
      clicks.map((r) => ({ date: r.date, count: Number(r.count) })),
      convs.map((r) => ({
        date: r.date,
        count: Number(r.count),
        revenue: Number(r.revenue),
        commission: Number(r.commission),
      }))
    );

    const totalClicks = series.reduce((s, d) => s + d.clicks, 0);
    const totalConversions = series.reduce((s, d) => s + d.conversions, 0);
    const totalRevenue = series.reduce((s, d) => s + Number(d.revenue), 0);
    const totalCommission = series.reduce((s, d) => s + Number(d.commission), 0);

    const response = {
      range: { start: start.toISOString(), end: end.toISOString() },
      series,
      totals: {
        clicks: totalClicks,
        conversions: totalConversions,
        revenue: totalRevenue.toFixed(2),
        commission: totalCommission.toFixed(2),
        conversionRate: safeRate(totalConversions, totalClicks),
        epc: epc(totalCommission, totalClicks),
      },
    };

    if (!compare) return response;

    // The immediately preceding window of the same length. Fetched only when
    // asked for: it doubles the query cost, and most callers do not need it.
    const previousWindow = previousPeriod(window);
    const previous = await seriesFor(scope, previousWindow);

    return {
      ...response,
      comparison: {
        range: {
          start: previousWindow.start.toISOString(),
          end: previousWindow.end.toISOString(),
        },
        clicks: comparePeriods(totalClicks, previous.clicks),
        conversions: comparePeriods(totalConversions, previous.conversions),
        revenue: comparePeriods(totalRevenue, previous.revenue),
        commission: comparePeriods(totalCommission, previous.commission),
        // The full series, so the chart can overlay it. Dates are the
        // *previous* window's, so the client aligns by index rather than by
        // date -- the two windows have no dates in common by construction.
        series: previous.series,
      },
    };
  }

  return {
    forBrand: (brandId: string, window: DateRange, compare = false) =>
      buildResponse({ brandId }, window, compare),
    forAffiliate: (affiliateId: string, window: DateRange, compare = false) =>
      buildResponse({ affiliateId }, window, compare),
  };
}

