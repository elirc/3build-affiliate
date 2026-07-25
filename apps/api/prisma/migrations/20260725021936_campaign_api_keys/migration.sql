-- CreateTable
CREATE TABLE "CampaignApiKey" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignApiKey_keyId_key" ON "CampaignApiKey"("keyId");

-- CreateIndex
CREATE INDEX "CampaignApiKey_campaignId_idx" ON "CampaignApiKey"("campaignId");

-- AddForeignKey
ALTER TABLE "CampaignApiKey" ADD CONSTRAINT "CampaignApiKey_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
