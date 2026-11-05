-- Durable round metrics for runs that are never saved as a model (FAILED, ABORTED, or completed but not saved).
-- Additive only: three nullable columns. Nothing is backfilled; NULL means "not captured".
ALTER TABLE "NvflareJob" ADD COLUMN "metricsJsonl" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "metricsChecksum" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "metricsCapturedAt" TIMESTAMP(3);
