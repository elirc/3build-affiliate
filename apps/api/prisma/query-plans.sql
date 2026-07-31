-- The queries behind fabledocs/05-query-performance.md.
--
-- Bind parameters are spelled out as literals, and the two ids are the ones
-- `prisma/seed-bulk.ts` creates, so that a plan captured here is a plan for
-- data anyone else can reproduce:
--
--   createdb affiliate_perf
--   DATABASE_URL=postgresql://.../affiliate_perf npx prisma migrate deploy
--   DATABASE_URL=postgresql://.../affiliate_perf npm run seed:bulk
--   psql ... -f apps/api/prisma/query-plans.sql
--
-- Literals rather than `PREPARE`/`EXECUTE` on purpose. A prepared statement
-- may switch to a generic plan after five executions, and a generic plan is
-- built without knowing the parameter values -- so it can differ from what a
-- one-off query does. The literal version is what `EXPLAIN` can show honestly;
-- the difference is worth knowing about and is called out in the doc.

\echo ==================== Q1 brand clicks by day (analytics.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT to_char("timestamp", 'YYYY-MM-DD') as date, COUNT(*)::bigint as count
FROM "ClickEvent" ce
JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
JOIN "Campaign" c ON c.id = tl."campaignId"
WHERE c."brandId" = 'perf-brand-0'
  AND ce."isCounted" = true
  AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
GROUP BY 1 ORDER BY 1;

\echo ==================== Q2 brand conversions by day (analytics.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT to_char(co."occurredAt", 'YYYY-MM-DD') as date,
       COUNT(*)::bigint as count,
       COALESCE(SUM(co."conversionValue"),0)::text as revenue,
       COALESCE(SUM(co."commissionAmount"),0)::text as commission
FROM "Conversion" co
JOIN "Campaign" c ON c.id = co."campaignId"
WHERE c."brandId" = 'perf-brand-0'
  AND co."occurredAt" >= NOW() - INTERVAL '30 days' AND co."occurredAt" <= NOW()
GROUP BY 1 ORDER BY 1;

\echo ==================== Q3 breakdown by campaign (breakdown.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
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
  JOIN "Campaign" cc ON cc.id = tl."campaignId" AND cc."brandId" = 'perf-brand-0'
  WHERE ce."isCounted" = true
  AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
  GROUP BY 1
) clicks ON clicks.cid = c.id
LEFT JOIN (
  SELECT co."campaignId" AS cid,
         COUNT(*) AS n,
         SUM(co."conversionValue") AS revenue,
         SUM(co."commissionAmount") AS commission
  FROM "Conversion" co
  JOIN "Campaign" cv ON cv.id = co."campaignId" AND cv."brandId" = 'perf-brand-0'
  WHERE co."occurredAt" >= NOW() - INTERVAL '30 days' AND co."occurredAt" <= NOW()
    AND co."status" = 'APPROVED'
  GROUP BY 1
) convs ON convs.cid = c.id
WHERE c."brandId" = 'perf-brand-0'
ORDER BY total_revenue DESC
LIMIT 200;

\echo ==================== Q4 breakdown by affiliate (breakdown.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
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
  WHERE c."brandId" = 'perf-brand-0'
    AND ce."isCounted" = true
    AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
  GROUP BY 1
) clicks ON clicks.aid = u.id
LEFT JOIN (
  SELECT co."affiliateId" AS aid,
         COUNT(*) AS n,
         SUM(co."conversionValue") AS revenue,
         SUM(co."commissionAmount") AS commission
  FROM "Conversion" co
  JOIN "Campaign" c ON c.id = co."campaignId"
  WHERE c."brandId" = 'perf-brand-0'
    AND co."occurredAt" >= NOW() - INTERVAL '30 days' AND co."occurredAt" <= NOW()
    AND co."status" = 'APPROVED'
  GROUP BY 1
) convs ON convs.aid = u.id
WHERE ba."brandId" = 'perf-brand-0' AND ba."status" = 'APPROVED'
ORDER BY total_revenue DESC
LIMIT 200;

\echo ==================== Q5 affiliate link breakdown (breakdown.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
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
  JOIN "TrackingLink" own ON own.id = ce."trackingLinkId"
    AND own."affiliateId" = 'perf-aff-0'
  WHERE ce."isCounted" = true
  AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
  GROUP BY 1
) clicks ON clicks.lid = tl.id
LEFT JOIN (
  SELECT co."trackingLinkId" AS lid,
         COUNT(*) AS n,
         SUM(co."conversionValue") AS revenue,
         SUM(co."commissionAmount") AS commission
  FROM "Conversion" co
  WHERE co."affiliateId" = 'perf-aff-0'
    AND co."occurredAt" >= NOW() - INTERVAL '30 days' AND co."occurredAt" <= NOW()
    AND co."status" = 'APPROVED'
  GROUP BY 1
) convs ON convs.lid = tl.id
WHERE tl."affiliateId" = 'perf-aff-0'
ORDER BY total_revenue DESC
LIMIT 200;

\echo ==================== Q6 sub-id report (breakdown.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
WITH clicks AS (
  SELECT ce."subIds"::jsonb ->> 'utm_source' AS value, COUNT(*) AS n
  FROM "ClickEvent" ce
  JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
  WHERE tl."affiliateId" = 'perf-aff-0'
    AND ce."isCounted" = true
    AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
    AND ce."subIds"::jsonb ->> 'utm_source' IS NOT NULL
  GROUP BY 1
),
convs AS (
  SELECT co."subIds"::jsonb ->> 'utm_source' AS value,
         COUNT(*) AS n,
         SUM(co."conversionValue") AS revenue,
         SUM(co."commissionAmount") AS commission
  FROM "Conversion" co
  WHERE co."affiliateId" = 'perf-aff-0'
    AND co."occurredAt" >= NOW() - INTERVAL '30 days' AND co."occurredAt" <= NOW()
    AND co."status" = 'APPROVED'
    AND co."subIds"::jsonb ->> 'utm_source' IS NOT NULL
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
LIMIT 200;

\echo ==================== Q7 affiliate clicks by day (analytics.service) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT to_char("timestamp", 'YYYY-MM-DD') as date, COUNT(*)::bigint as count
FROM "ClickEvent" ce
JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
WHERE tl."affiliateId" = 'perf-aff-0'
  AND ce."isCounted" = true
  AND ce."timestamp" >= NOW() - INTERVAL '30 days' AND ce."timestamp" <= NOW()
GROUP BY 1 ORDER BY 1;

\echo ==================== Q8 attribution lookup (conversion.service, postback hot path) ====================
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT ce.id, ce."trackingLinkId", ce."timestamp", ce."subIds"
FROM "ClickEvent" ce
JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
WHERE ce."attributionCookieId" = 'perf-cookie-28'
  AND ce."timestamp" >= NOW() - INTERVAL '30 days'
  AND ce."timestamp" <= NOW()
  AND ce."isCounted" = true
  AND tl."campaignId" = 'perf-camp-0'
ORDER BY ce."timestamp" ASC;
