-- CreateEnum
CREATE TYPE "ConversionSource" AS ENUM ('POSTBACK', 'IMPORT');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Conversion" ADD COLUMN     "source" "ConversionSource" NOT NULL DEFAULT 'POSTBACK';

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sourcePath" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJobError" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "column" TEXT,
    "message" TEXT NOT NULL,

    CONSTRAINT "ImportJobError_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_campaignId_createdAt_idx" ON "ImportJob"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_idx" ON "ImportJob"("status");

-- CreateIndex
CREATE INDEX "ImportJobError_jobId_line_idx" ON "ImportJobError"("jobId", "line");

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJobError" ADD CONSTRAINT "ImportJobError_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

