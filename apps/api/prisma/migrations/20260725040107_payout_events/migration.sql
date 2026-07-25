-- CreateTable
CREATE TABLE "PayoutEvent" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "fromStatus" "PayoutStatus" NOT NULL,
    "toStatus" "PayoutStatus" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutEvent_payoutId_idx" ON "PayoutEvent"("payoutId");

-- AddForeignKey
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
