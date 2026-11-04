-- Additive only: a new enum, four nullable columns, one index and one foreign key.
-- Nothing is backfilled and no existing column is touched; NULL sourceKind means "created before lineage existed".
CREATE TYPE "PipelineSourceKind" AS ENUM ('template', 'assistant', 'import', 'copy');

ALTER TABLE "PipelineProject" ADD COLUMN "sourceKind" "PipelineSourceKind";
ALTER TABLE "PipelineProject" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "PipelineProject" ADD COLUMN "parentProjectId" TEXT;
ALTER TABLE "PipelineProject" ADD COLUMN "parentVersion" TEXT;

CREATE INDEX "PipelineProject_parentProjectId_idx" ON "PipelineProject"("parentProjectId");

ALTER TABLE "PipelineProject" ADD CONSTRAINT "PipelineProject_parentProjectId_fkey"
  FOREIGN KEY ("parentProjectId") REFERENCES "PipelineProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
