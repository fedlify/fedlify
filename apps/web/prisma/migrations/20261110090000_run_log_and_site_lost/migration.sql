-- Durable server log for runs that are never saved as a model, and the site-lost episode state used by run reconcile.
-- Additive only: seven nullable columns, no defaults, nothing backfilled. NULL means "not captured" / "no episode".
ALTER TABLE "NvflareJob" ADD COLUMN "logText" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "logChecksum" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "logTruncated" BOOLEAN;
ALTER TABLE "NvflareJob" ADD COLUMN "logCapturedAt" TIMESTAMP(3);
ALTER TABLE "NvflareJob" ADD COLUMN "siteLostSince" TIMESTAMP(3);
ALTER TABLE "NvflareJob" ADD COLUMN "siteLostSeenAt" TIMESTAMP(3);
ALTER TABLE "NvflareJob" ADD COLUMN "siteLostSites" JSONB;
