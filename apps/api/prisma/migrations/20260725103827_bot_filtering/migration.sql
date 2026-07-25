-- AlterTable
ALTER TABLE "ClickEvent" ADD COLUMN     "isCounted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "trafficKind" TEXT NOT NULL DEFAULT 'human';

-- CreateIndex
CREATE INDEX "ClickEvent_isCounted_timestamp_idx" ON "ClickEvent"("isCounted", "timestamp");

