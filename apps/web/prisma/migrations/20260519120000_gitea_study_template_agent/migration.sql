-- Study-scoped GitOps workspaces and agentic NVFLARE template sessions.
CREATE TYPE "TemplateScope" AS ENUM ('PUBLIC_TEMPLATE', 'STUDY_TEMPLATE', 'STUDY_PIPELINE');
CREATE TYPE "GiteaWorkspaceStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');
CREATE TYPE "TemplateAgentSessionMode" AS ENUM ('FROM_PUBLIC_TEMPLATE', 'FROM_STUDY_TEMPLATE', 'FROM_SCRATCH');
CREATE TYPE "TemplateAgentSessionStatus" AS ENUM ('INTAKE', 'CODING', 'DRAFT_READY', 'APPLIED', 'FAILED');

DROP INDEX IF EXISTS "PipelineTemplate_templateKey_key";

ALTER TABLE "PipelineTemplate"
  ADD COLUMN "scope" "TemplateScope" NOT NULL DEFAULT 'PUBLIC_TEMPLATE',
  ADD COLUMN "studyId" TEXT,
  ADD COLUMN "sourceTemplateId" TEXT,
  ADD COLUMN "sourceTemplateVersionId" TEXT,
  ADD COLUMN "forkedFromCommit" TEXT;

CREATE TABLE "GiteaWorkspace" (
  "id" TEXT NOT NULL,
  "studyId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "url" TEXT,
  "status" "GiteaWorkspaceStatus" NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GiteaWorkspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TemplateAgentSession" (
  "id" TEXT NOT NULL,
  "studyId" TEXT,
  "templateId" TEXT,
  "requestedById" TEXT NOT NULL,
  "mode" "TemplateAgentSessionMode" NOT NULL,
  "status" "TemplateAgentSessionStatus" NOT NULL DEFAULT 'INTAKE',
  "intake" JSONB NOT NULL DEFAULT '{}',
  "messages" JSONB NOT NULL DEFAULT '[]',
  "generatedFiles" JSONB,
  "resultSummary" TEXT,
  "giteaOwner" TEXT,
  "giteaRepo" TEXT,
  "branchName" TEXT,
  "giteaPullRequestUrl" TEXT,
  "giteaHeadCommit" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TemplateAgentSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiteaWorkspace_studyId_key" ON "GiteaWorkspace"("studyId");
CREATE UNIQUE INDEX "GiteaWorkspace_owner_key" ON "GiteaWorkspace"("owner");
CREATE INDEX "GiteaWorkspace_status_idx" ON "GiteaWorkspace"("status");
CREATE INDEX "PipelineTemplate_scope_active_idx" ON "PipelineTemplate"("scope", "active");
CREATE INDEX "PipelineTemplate_studyId_scope_idx" ON "PipelineTemplate"("studyId", "scope");
CREATE INDEX "PipelineTemplate_templateKey_idx" ON "PipelineTemplate"("templateKey");
CREATE INDEX "TemplateAgentSession_studyId_status_idx" ON "TemplateAgentSession"("studyId", "status");
CREATE INDEX "TemplateAgentSession_templateId_status_idx" ON "TemplateAgentSession"("templateId", "status");
CREATE INDEX "TemplateAgentSession_requestedById_createdAt_idx" ON "TemplateAgentSession"("requestedById", "createdAt");

ALTER TABLE "PipelineTemplate" ADD CONSTRAINT "PipelineTemplate_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineTemplate" ADD CONSTRAINT "PipelineTemplate_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES "PipelineTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PipelineTemplate" ADD CONSTRAINT "PipelineTemplate_sourceTemplateVersionId_fkey" FOREIGN KEY ("sourceTemplateVersionId") REFERENCES "PipelineTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GiteaWorkspace" ADD CONSTRAINT "GiteaWorkspace_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GiteaWorkspace" ADD CONSTRAINT "GiteaWorkspace_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TemplateAgentSession" ADD CONSTRAINT "TemplateAgentSession_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateAgentSession" ADD CONSTRAINT "TemplateAgentSession_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PipelineTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TemplateAgentSession" ADD CONSTRAINT "TemplateAgentSession_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
