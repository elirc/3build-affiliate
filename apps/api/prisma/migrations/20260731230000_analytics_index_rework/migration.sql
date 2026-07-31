-- Index rework for the analytics aggregates. The evidence for every line in
-- this file -- the plan that changed, or the scan count that stayed at zero --
-- is in fabledocs/05-query-performance.md.
--
-- For whoever runs this against a large production ClickEvent: Prisma wraps a
-- migration in a transaction, and `CREATE INDEX CONCURRENTLY` cannot run
-- inside one, so this holds a lock on ClickEvent for the length of the build.
-- At 500k rows that is seconds. At 500 million it is not, and the index should
-- be built by hand with CONCURRENTLY first -- after which this migration finds
-- it already there and the CREATE is the cheap half.

-- DropIndex
DROP INDEX "User_email_idx";

-- DropIndex
DROP INDEX "Campaign_slug_idx";

-- DropIndex
DROP INDEX "TrackingLink_shortCode_idx";

-- DropIndex
DROP INDEX "ClickEvent_trackingLinkId_idx";

-- DropIndex
DROP INDEX "ClickEvent_ipHash_idx";

-- DropIndex
DROP INDEX "ClickEvent_isCounted_timestamp_idx";

-- DropIndex
DROP INDEX "Conversion_affiliateId_status_idx";

-- CreateIndex
CREATE INDEX "ClickEvent_trackingLinkId_isCounted_timestamp_idx" ON "ClickEvent"("trackingLinkId", "isCounted", "timestamp");

-- CreateIndex
CREATE INDEX "Conversion_affiliateId_status_occurredAt_idx" ON "Conversion"("affiliateId", "status", "occurredAt");

