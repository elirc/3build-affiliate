-- AlterTable
ALTER TABLE "User" ADD COLUMN     "manualPayoutDetails" TEXT,
ADD COLUMN     "payoutMethod" "PayoutMethod",
ADD COLUMN     "paypalEmail" TEXT;

