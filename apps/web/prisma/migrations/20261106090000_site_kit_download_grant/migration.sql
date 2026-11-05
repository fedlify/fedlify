-- Additive only: two nullable columns. Nothing is backfilled; NULL means "no download grant outstanding".
ALTER TABLE "SiteJoinPackage" ADD COLUMN "downloadGrantHash" TEXT;
ALTER TABLE "SiteJoinPackage" ADD COLUMN "downloadGrantExpiresAt" TIMESTAMP(3);
