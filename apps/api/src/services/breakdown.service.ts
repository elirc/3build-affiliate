import { epc, resolveSort, safeRate } from '@affiliate/analytics';
import { Prisma } from '@prisma/client';
import type { AffiliateSummary, CampaignSummary } from '@affiliate/shared';
import { prisma } from '../config/prisma';

/**
 * Per-dimension performance breakdowns.
 *
 * The daily series in analytics.service answers "how are we doing?". These
 * answer "which of these is doing it", which is the question that actually
 * changes a decision.
 *
 * `CampaignSummary` and `AffiliateSummary` have been in packages/shared since
 * the first commit with no producer. This is it.
 */

const DEFAULT_DAYS = 30;

/**
 * Only these keys can reach ORDER BY, and only as a lookup into values we
 * wrote. A column name cannot be a bind parameter, which is exactly why people
 * interpolate it and exactly why this map exists instead.
 */
const BREAKDOWN_SORT = {
  columns: {
    clicks: 'total_clicks',
    conversions: 'total_conversions',
    revenue: 'total_revenue',
    commission: 'total_commission',
    name: 'name',
  },
  defaultKey: 'revenue' as const,
};

export interface BreakdownOptions {
  days?: number;
  sort?: string;
  direction?: string;
  /**
   * Include PENDING conversions as well as APPROVED.
   *
   * "Booked" versus "confirmed" revenue is the most common support question
   * in an affiliate programme, so the caller has to choose rather than
   * inheriting whichever we happened to pick.
   */
  includePending?: boolean;
}

interface BreakdownRow {
  total_clicks: bigint;
  total_conversions: bigint;
  total_revenue: string;
  total_commission: string;
}

function windowFor(days: number) {
  const end = new Date();
  return { start: new Date(end.getTime() - days * 86400 * 1000), end };
}

/**
 * Clicks and conversions are aggregated in separate subqueries, then joined.
 *
 * Joining ClickEvent and Conversion to the same rows multiplies them together:
 * three clicks and two conversions would report six of each. That fan-out is
 * the classic way to get an analytics query quietly, plausibly wrong -- the
 * numbers look like numbers, they are just not the right ones.
 */
function statusFilter(includePending: boolean) {
  return includePending
    ? Prisma.sql`co."status" IN ('APPROVED', 'PENDING')`
    : Prisma.sql`co."status" = 'APPROVED'`;
}

/** Shared so a rate is never computed two slightly different ways. */
function totals(r: BreakdownRow) {
  const clicks = Number(r.total_clicks);
  const conversions = Number(r.total_conversions);
  return {
    totalClicks: clicks,
    totalConversions: conversions,
    totalRevenue: Number(r.total_revenue).toFixed(2),
    totalCommission: Number(r.total_commission).toFixed(2),
    conversionRate: safeRate(conversions, clicks),
  };
}

export function breakdownService() {
  return {
    async byCampaign(
      brandId: string,
      opts: BreakdownOptions = {}
    ): Promise<CampaignSummary[]> {
      const { start, end } = windowFor(opts.days ?? DEFAULT_DAYS);
      const sort = resolveSort(BREAKDOWN_SORT, opts.sort, opts.direction);

      const rows = await prisma.$queryRaw<
        Array<BreakdownRow & { campaignId: string; name: string }>
      >`
        SELECT c.id                              AS "campaignId",
               c.name                            AS name,
               COALESCE(clicks.n, 0)::bigint     AS total_clicks,
               COALESCE(convs.n, 0)::bigint      AS total_conversions,
               COALESCE(convs.revenue, 0)::text  AS total_revenue,
               COALESCE(convs.commission, 0)::text AS total_commission
        FROM "Campaign" c
        LEFT JOIN (
          SELECT tl."campaignId" AS cid, COUNT(*) AS n
          FROM "ClickEvent" ce
          JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
          WHERE ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
          GROUP BY 1
        ) clicks ON clicks.cid = c.id
        LEFT JOIN (
          SELECT co."campaignId" AS cid,
                 COUNT(*) AS n,
                 SUM(co."conversionValue") AS revenue,
                 SUM(co."commissionAmount") AS commission
          FROM "Conversion" co
          WHERE co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
            AND ${statusFilter(opts.includePending ?? false)}
          GROUP BY 1
        ) convs ON convs.cid = c.id
        WHERE c."brandId" = ${brandId}
        ORDER BY ${Prisma.raw(sort.column)} ${Prisma.raw(sort.direction)}
        LIMIT 200
      `;

      return rows.map((r) => ({
        campaignId: r.campaignId,
        campaignName: r.name,
        ...totals(r),
        epc: epc(Number(r.total_commission), Number(r.total_clicks)),
      }));
    },

    async byAffiliate(
      brandId: string,
      opts: BreakdownOptions = {}
    ): Promise<AffiliateSummary[]> {
      const { start, end } = windowFor(opts.days ?? DEFAULT_DAYS);
      const sort = resolveSort(BREAKDOWN_SORT, opts.sort, opts.direction);

      const rows = await prisma.$queryRaw<
        Array<BreakdownRow & { affiliateId: string; name: string }>
      >`
        SELECT u.id AS "affiliateId",
               (u."firstName" || ' ' || u."lastName") AS name,
               COALESCE(clicks.n, 0)::bigint     AS total_clicks,
               COALESCE(convs.n, 0)::bigint      AS total_conversions,
               COALESCE(convs.revenue, 0)::text  AS total_revenue,
               COALESCE(convs.commission, 0)::text AS total_commission
        FROM "BrandAffiliate" ba
        JOIN "User" u ON u.id = ba."affiliateId"
        LEFT JOIN (
          SELECT tl."affiliateId" AS aid, COUNT(*) AS n
          FROM "ClickEvent" ce
          JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
          JOIN "Campaign" c ON c.id = tl."campaignId"
          WHERE c."brandId" = ${brandId}
            AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
          GROUP BY 1
        ) clicks ON clicks.aid = u.id
        LEFT JOIN (
          SELECT co."affiliateId" AS aid,
                 COUNT(*) AS n,
                 SUM(co."conversionValue") AS revenue,
                 SUM(co."commissionAmount") AS commission
          FROM "Conversion" co
          JOIN "Campaign" c ON c.id = co."campaignId"
          WHERE c."brandId" = ${brandId}
            AND co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
            AND ${statusFilter(opts.includePending ?? false)}
          GROUP BY 1
        ) convs ON convs.aid = u.id
        WHERE ba."brandId" = ${brandId} AND ba."status" = 'APPROVED'
        ORDER BY ${Prisma.raw(sort.column)} ${Prisma.raw(sort.direction)}
        LIMIT 200
      `;

      return rows.map((r) => ({
        affiliateId: r.affiliateId,
        affiliateName: r.name,
        ...totals(r),
      }));
    },

    /** An affiliate's own campaigns, from their side of the relationship. */
    async forAffiliateOwnCampaigns(
      affiliateId: string,
      opts: BreakdownOptions = {}
    ): Promise<CampaignSummary[]> {
      const { start, end } = windowFor(opts.days ?? DEFAULT_DAYS);
      const sort = resolveSort(BREAKDOWN_SORT, opts.sort, opts.direction);

      const rows = await prisma.$queryRaw<
        Array<BreakdownRow & { campaignId: string; name: string }>
      >`
        SELECT c.id AS "campaignId",
               c.name AS name,
               COALESCE(clicks.n, 0)::bigint     AS total_clicks,
               COALESCE(convs.n, 0)::bigint      AS total_conversions,
               COALESCE(convs.revenue, 0)::text  AS total_revenue,
               COALESCE(convs.commission, 0)::text AS total_commission
        FROM "Campaign" c
        JOIN (
          SELECT DISTINCT "campaignId"
          FROM "TrackingLink"
          WHERE "affiliateId" = ${affiliateId}
        ) mine ON mine."campaignId" = c.id
        LEFT JOIN (
          SELECT tl."campaignId" AS cid, COUNT(*) AS n
          FROM "ClickEvent" ce
          JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
          WHERE tl."affiliateId" = ${affiliateId}
            AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
          GROUP BY 1
        ) clicks ON clicks.cid = c.id
        LEFT JOIN (
          SELECT co."campaignId" AS cid,
                 COUNT(*) AS n,
                 SUM(co."conversionValue") AS revenue,
                 SUM(co."commissionAmount") AS commission
          FROM "Conversion" co
          WHERE co."affiliateId" = ${affiliateId}
            AND co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
            AND ${statusFilter(opts.includePending ?? false)}
          GROUP BY 1
        ) convs ON convs.cid = c.id
        ORDER BY ${Prisma.raw(sort.column)} ${Prisma.raw(sort.direction)}
        LIMIT 200
      `;

      return rows.map((r) => ({
        campaignId: r.campaignId,
        campaignName: r.name,
        ...totals(r),
        epc: epc(Number(r.total_commission), Number(r.total_clicks)),
      }));
    },

    /** Per-link breakdown, so an affiliate can see which placement works. */
    async forAffiliateLinks(affiliateId: string, opts: BreakdownOptions = {}) {
      const { start, end } = windowFor(opts.days ?? DEFAULT_DAYS);

      const rows = await prisma.$queryRaw<
        Array<
          BreakdownRow & { linkId: string; shortCode: string; name: string }
        >
      >`
        SELECT tl.id AS "linkId",
               tl."shortCode" AS "shortCode",
               c.name AS name,
               COALESCE(clicks.n, 0)::bigint     AS total_clicks,
               COALESCE(convs.n, 0)::bigint      AS total_conversions,
               COALESCE(convs.revenue, 0)::text  AS total_revenue,
               COALESCE(convs.commission, 0)::text AS total_commission
        FROM "TrackingLink" tl
        JOIN "Campaign" c ON c.id = tl."campaignId"
        LEFT JOIN (
          SELECT ce."trackingLinkId" AS lid, COUNT(*) AS n
          FROM "ClickEvent" ce
          WHERE ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
          GROUP BY 1
        ) clicks ON clicks.lid = tl.id
        LEFT JOIN (
          SELECT co."trackingLinkId" AS lid,
                 COUNT(*) AS n,
                 SUM(co."conversionValue") AS revenue,
                 SUM(co."commissionAmount") AS commission
          FROM "Conversion" co
          WHERE co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
            AND ${statusFilter(opts.includePending ?? false)}
          GROUP BY 1
        ) convs ON convs.lid = tl.id
        WHERE tl."affiliateId" = ${affiliateId}
        ORDER BY total_revenue DESC
        LIMIT 200
      `;

      return rows.map((r) => ({
        linkId: r.linkId,
        shortCode: r.shortCode,
        campaignName: r.name,
        ...totals(r),
        epc: epc(Number(r.total_commission), Number(r.total_clicks)),
      }));
    },
  };
}

/**
 * Sub-ID performance for one affiliate.
 *
 * Kept apart from `breakdownService` because it groups by a JSON key rather
 * than a column, which needs a different shape: the key is a bind parameter
 * feeding `->>`, and the set of possible values is not known in advance.
 */
export function subIdService() {
  return {
    /** The sub-ID keys this affiliate has actually used, for a picker. */
    async keys(affiliateId: string, days = DEFAULT_DAYS): Promise<string[]> {
      const { start, end } = windowFor(days);
      const rows = await prisma.$queryRaw<Array<{ key: string }>>`
        SELECT DISTINCT jsonb_object_keys(ce."subIds"::jsonb) AS key
        FROM "ClickEvent" ce
        JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
        WHERE tl."affiliateId" = ${affiliateId}
          AND ce."subIds" IS NOT NULL
          AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
        ORDER BY key
        LIMIT 50
      `;
      return rows.map((r) => r.key);
    },

    /**
     * Clicks, conversions and revenue grouped by the value of one sub-ID key.
     *
     * Clicks come from ClickEvent and conversions from the snapshot on
     * Conversion, joined on the value rather than on a row. Joining the two
     * tables directly would multiply them together -- the same fan-out the
     * campaign breakdowns avoid.
     */
    async report(affiliateId: string, key: string, days = DEFAULT_DAYS) {
      const { start, end } = windowFor(days);

      const rows = await prisma.$queryRaw<
        Array<{
          value: string;
          total_clicks: bigint;
          total_conversions: bigint;
          total_revenue: string;
          total_commission: string;
        }>
      >`
        WITH clicks AS (
          SELECT ce."subIds"::jsonb ->> ${key} AS value, COUNT(*) AS n
          FROM "ClickEvent" ce
          JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
          WHERE tl."affiliateId" = ${affiliateId}
            AND ce."timestamp" >= ${start} AND ce."timestamp" <= ${end}
            AND ce."subIds"::jsonb ->> ${key} IS NOT NULL
          GROUP BY 1
        ),
        convs AS (
          SELECT co."subIds"::jsonb ->> ${key} AS value,
                 COUNT(*) AS n,
                 SUM(co."conversionValue") AS revenue,
                 SUM(co."commissionAmount") AS commission
          FROM "Conversion" co
          WHERE co."affiliateId" = ${affiliateId}
            AND co."occurredAt" >= ${start} AND co."occurredAt" <= ${end}
            AND co."status" = 'APPROVED'
            AND co."subIds"::jsonb ->> ${key} IS NOT NULL
          GROUP BY 1
        )
        SELECT COALESCE(clicks.value, convs.value)   AS value,
               COALESCE(clicks.n, 0)::bigint         AS total_clicks,
               COALESCE(convs.n, 0)::bigint          AS total_conversions,
               COALESCE(convs.revenue, 0)::text      AS total_revenue,
               COALESCE(convs.commission, 0)::text   AS total_commission
        FROM clicks
        FULL OUTER JOIN convs ON convs.value = clicks.value
        ORDER BY total_revenue DESC, total_clicks DESC
        LIMIT 200
      `;

      return rows.map((r) => ({
        value: r.value,
        ...totals(r),
        epc: epc(Number(r.total_commission), Number(r.total_clicks)),
      }));
    },
  };
}
