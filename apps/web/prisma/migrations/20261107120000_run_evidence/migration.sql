-- Durable run evidence. Additive only: two enum values and five nullable columns. Nothing is backfilled;
-- NULL means "not recorded" and the run detail page says so.
ALTER TYPE "ModelArtifactKind" ADD VALUE IF NOT EXISTS 'ROUND_METRICS';
ALTER TYPE "ModelArtifactKind" ADD VALUE IF NOT EXISTS 'MODEL_CARD';

ALTER TABLE "NvflareJob" ADD COLUMN "gitCommit" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "imageDigest" TEXT;
ALTER TABLE "NvflareJob" ADD COLUMN "siteDigests" JSONB;
ALTER TABLE "NvflareJob" ADD COLUMN "runParameters" JSONB;
ALTER TABLE "NvflareJob" ADD COLUMN "metricsSummary" JSONB;
