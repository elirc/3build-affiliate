-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "trackingLinkId" TEXT NOT NULL,
    "originalConversionId" TEXT NOT NULL,
    "customerEmailHash" TEXT,
    "externalReference" TEXT NOT NULL,
    "commissionSnapshot" JSONB NOT NULL,
    "totalPeriods" INTEGER NOT NULL,
    "completedPeriods" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_originalConversionId_key" ON "Subscription"("originalConversionId");

-- CreateIndex
CREATE INDEX "Subscription_affiliateId_status_idx" ON "Subscription"("affiliateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_campaignId_externalReference_key" ON "Subscription"("campaignId", "externalReference");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_trackingLinkId_fkey" FOREIGN KEY ("trackingLinkId") REFERENCES "TrackingLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

