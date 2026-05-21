-- Gitea-backed reusable NVFLARE template catalog.
CREATE TYPE "TemplateProposalKind" AS ENUM ('NEW_TEMPLATE', 'CHANGE_TEMPLATE');

ALTER TABLE "PipelineTemplate"
  ADD COLUMN "status" "PipelineVersionStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "giteaOwner" TEXT,
  ADD COLUMN "giteaRepo" TEXT,
  ADD COLUMN "giteaRepoUrl" TEXT,
  ADD COLUMN "giteaDefaultBranch" TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN "currentApprovedVersionId" TEXT;

CREATE TABLE "PipelineTemplateVersion" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "gitCommit" TEXT NOT NULL,
  "gitBranch" TEXT,
  "artifactStorageKey" TEXT,
  "validationStatus" "CIValidationStatus" NOT NULL DEFAULT 'QUEUED',
  "approvalStatus" "PipelineVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "immutable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PipelineTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TemplateProposal" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "kind" "TemplateProposalKind" NOT NULL,
  "intakeAnswers" JSONB NOT NULL,
  "prompt" TEXT NOT NULL,
  "branchName" TEXT NOT NULL,
  "giteaPullRequestUrl" TEXT,
  "giteaPullRequestNumber" INTEGER,
  "giteaHeadCommit" TEXT,
  "giteaBaseBranch" TEXT,
  "status" "AgentProposalStatus" NOT NULL DEFAULT 'OPEN',
  "validationStatus" "CIValidationStatus" NOT NULL DEFAULT 'QUEUED',
  "resultSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TemplateProposal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PipelineProject" ADD COLUMN "templateVersionId" TEXT;
ALTER TABLE "PipelineVersion" ADD COLUMN "templateVersionId" TEXT;

CREATE UNIQUE INDEX "PipelineTemplateVersion_templateId_version_key" ON "PipelineTemplateVersion"("templateId", "version");
CREATE UNIQUE INDEX "PipelineTemplateVersion_templateId_gitCommit_key" ON "PipelineTemplateVersion"("templateId", "gitCommit");
CREATE INDEX "PipelineTemplateVersion_approvalStatus_validationStatus_idx" ON "PipelineTemplateVersion"("approvalStatus", "validationStatus");
CREATE INDEX "PipelineTemplate_status_active_idx" ON "PipelineTemplate"("status", "active");
CREATE INDEX "TemplateProposal_templateId_status_idx" ON "TemplateProposal"("templateId", "status");
CREATE INDEX "TemplateProposal_validationStatus_idx" ON "TemplateProposal"("validationStatus");

ALTER TABLE "PipelineTemplateVersion" ADD CONSTRAINT "PipelineTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PipelineTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineTemplateVersion" ADD CONSTRAINT "PipelineTemplateVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PipelineTemplate" ADD CONSTRAINT "PipelineTemplate_currentApprovedVersionId_fkey" FOREIGN KEY ("currentApprovedVersionId") REFERENCES "PipelineTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PipelineProject" ADD CONSTRAINT "PipelineProject_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "PipelineTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PipelineVersion" ADD CONSTRAINT "PipelineVersion_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "PipelineTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TemplateProposal" ADD CONSTRAINT "TemplateProposal_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PipelineTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateProposal" ADD CONSTRAINT "TemplateProposal_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Development compatibility: existing metadata-only seed templates become approved
-- legacy versions until they are reseeded into source-backed Gitea repos.
INSERT INTO "PipelineTemplateVersion" (
  "id",
  "templateId",
  "version",
  "gitCommit",
  "gitBranch",
  "validationStatus",
  "approvalStatus",
  "approvedAt",
  "immutable",
  "createdAt",
  "updatedAt"
)
SELECT
  CONCAT('template-version-', "templateKey"),
  "id",
  "version",
  CONCAT('legacy-seed-', "templateKey"),
  'main',
  'PASSED',
  'APPROVED',
  CURRENT_TIMESTAMP,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "PipelineTemplate"
ON CONFLICT ("templateId", "version") DO NOTHING;

UPDATE "PipelineTemplate" t
SET
  "status" = 'APPROVED',
  "currentApprovedVersionId" = tv."id"
FROM "PipelineTemplateVersion" tv
WHERE tv."templateId" = t."id"
  AND tv."approvalStatus" = 'APPROVED'
  AND t."currentApprovedVersionId" IS NULL;
