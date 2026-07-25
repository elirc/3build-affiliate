-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payout_affiliateId_idempotencyKey_key" ON "Payout"("affiliateId", "idempotencyKey");

