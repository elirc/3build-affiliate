-- CreateTable
CREATE TABLE "CommissionOverrideEvent" (
    "id" TEXT NOT NULL,
    "brandAffiliateId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionOverrideEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionOverrideEvent_brandAffiliateId_idx" ON "CommissionOverrideEvent"("brandAffiliateId");

-- AddForeignKey
ALTER TABLE "CommissionOverrideEvent" ADD CONSTRAINT "CommissionOverrideEvent_brandAffiliateId_fkey" FOREIGN KEY ("brandAffiliateId") REFERENCES "BrandAffiliate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

