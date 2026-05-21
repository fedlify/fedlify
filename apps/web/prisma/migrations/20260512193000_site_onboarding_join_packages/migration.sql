-- CreateEnum
CREATE TYPE "SiteJoinPackageKind" AS ENUM ('STARTUP_KIT');

-- CreateEnum
CREATE TYPE "SiteJoinPackageStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "SiteReadinessCheck"
ADD COLUMN "policyAcceptedById" TEXT,
ADD COLUMN "policyAcceptedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SiteJoinPackage" (
    "id" TEXT NOT NULL,
    "studySiteId" TEXT NOT NULL,
    "generatedById" TEXT NOT NULL,
    "kind" "SiteJoinPackageKind" NOT NULL DEFAULT 'STARTUP_KIT',
    "status" "SiteJoinPackageStatus" NOT NULL DEFAULT 'ACTIVE',
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/json',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteJoinPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteJoinPackage_storageKey_key" ON "SiteJoinPackage"("storageKey");

-- CreateIndex
CREATE INDEX "SiteJoinPackage_studySiteId_status_idx" ON "SiteJoinPackage"("studySiteId", "status");

-- CreateIndex
CREATE INDEX "SiteJoinPackage_expiresAt_idx" ON "SiteJoinPackage"("expiresAt");

-- AddForeignKey
ALTER TABLE "SiteJoinPackage" ADD CONSTRAINT "SiteJoinPackage_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteJoinPackage" ADD CONSTRAINT "SiteJoinPackage_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
