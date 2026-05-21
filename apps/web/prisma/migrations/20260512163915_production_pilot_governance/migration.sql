-- CreateEnum
CREATE TYPE "GovernanceStatus" AS ENUM ('INCOMPLETE', 'PENDING_APPROVAL', 'APPROVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "StudyRiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH');

-- CreateEnum
CREATE TYPE "SiteRole" AS ENUM ('SITE_PI', 'SITE_ADMIN', 'SITE_DATA_STEWARD', 'SITE_ENGINEER', 'SITE_REVIEWER');

-- CreateEnum
CREATE TYPE "ReadinessStatus" AS ENUM ('PENDING', 'PASSED', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "PipelineVersionStatus" AS ENUM ('DRAFT', 'VALIDATING', 'VALIDATED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AgentProposalStatus" AS ENUM ('DRAFT', 'OPEN', 'MERGED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CIValidationStatus" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NvflareDeploymentStatus" AS ENUM ('DRAFT', 'PROVISIONED', 'ACTIVE', 'PAUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "NvflareJobStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NvflareJobEventType" AS ENUM ('SUBMITTED', 'SCHEDULED', 'STARTED', 'SITE_UPDATE', 'METRIC_UPDATE', 'LOG_AVAILABLE', 'COMPLETED', 'FAILED', 'ABORTED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StudyRole" ADD VALUE 'PRINCIPAL_INVESTIGATOR';
ALTER TYPE "StudyRole" ADD VALUE 'CLINICAL_LEAD';
ALTER TYPE "StudyRole" ADD VALUE 'PIPELINE_DEVELOPER';
ALTER TYPE "StudyRole" ADD VALUE 'PRIVACY_SECURITY_OFFICER';
ALTER TYPE "StudyRole" ADD VALUE 'RELEASE_APPROVER';

-- AlterTable
ALTER TABLE "Study" ADD COLUMN     "clinicalUseCase" TEXT,
ADD COLUMN     "dataModalities" TEXT,
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "governanceStatus" "GovernanceStatus" NOT NULL DEFAULT 'INCOMPLETE',
ADD COLUMN     "intendedUse" TEXT,
ADD COLUMN     "population" TEXT,
ADD COLUMN     "primaryOutcome" TEXT,
ADD COLUMN     "researchQuestion" TEXT,
ADD COLUMN     "riskLevel" "StudyRiskLevel" NOT NULL DEFAULT 'MODERATE';

-- CreateTable
CREATE TABLE "StudySite" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "siteId" TEXT,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institutionName" TEXT NOT NULL,
    "participationStatus" "SiteStatus" NOT NULL DEFAULT 'INVITED',
    "principalInvestigator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudySite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteResourceProfile" (
    "id" TEXT NOT NULL,
    "studySiteId" TEXT NOT NULL,
    "cpuCores" INTEGER,
    "gpuCount" INTEGER,
    "gpuModel" TEXT,
    "ramGb" INTEGER,
    "storageGb" INTEGER,
    "networkBandwidthMbps" INTEGER,
    "runtimeConstraints" TEXT,
    "dependencySummary" TEXT,
    "allowByoc" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteResourceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteDataProfile" (
    "id" TEXT NOT NULL,
    "studySiteId" TEXT NOT NULL,
    "modality" TEXT,
    "datasetDescription" TEXT,
    "cohortSizeRange" TEXT,
    "inclusionCriteria" TEXT,
    "exclusionCriteria" TEXT,
    "dataResidency" TEXT,
    "deidentificationSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDataProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteMember" (
    "id" TEXT NOT NULL,
    "studySiteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SiteRole" NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteReadinessCheck" (
    "id" TEXT NOT NULL,
    "studySiteId" TEXT NOT NULL,
    "checkedById" TEXT,
    "connectivityVerified" BOOLEAN NOT NULL DEFAULT false,
    "kitInstalled" BOOLEAN NOT NULL DEFAULT false,
    "dependenciesVerified" BOOLEAN NOT NULL DEFAULT false,
    "policyAccepted" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReadinessStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteReadinessCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "framework" TEXT NOT NULL DEFAULT 'nvflare',
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "spec" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineProject" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "giteaRepoUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "status" "PipelineVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateId" TEXT,
    "version" TEXT NOT NULL,
    "gitCommit" TEXT,
    "gitBranch" TEXT,
    "artifactStorageKey" TEXT,
    "validationStatus" "CIValidationStatus" NOT NULL DEFAULT 'QUEUED',
    "approvalStatus" "PipelineVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "immutable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "giteaPullRequestUrl" TEXT,
    "status" "AgentProposalStatus" NOT NULL DEFAULT 'OPEN',
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CIValidationRun" (
    "id" TEXT NOT NULL,
    "pipelineVersionId" TEXT,
    "agentProposalId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'argo',
    "workflowId" TEXT,
    "status" "CIValidationStatus" NOT NULL DEFAULT 'QUEUED',
    "summary" TEXT,
    "logsStorageKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CIValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvflareDeployment" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dashboardUrl" TEXT,
    "serverStartupKitStorageKey" TEXT,
    "adminStartupKitStorageKey" TEXT,
    "activeAdminEmail" TEXT,
    "status" "NvflareDeploymentStatus" NOT NULL DEFAULT 'DRAFT',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NvflareDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvflareJob" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "pipelineVersionId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "nvflareJobId" TEXT,
    "status" "NvflareJobStatus" NOT NULL DEFAULT 'DRAFT',
    "selectedSites" JSONB,
    "commandSummary" TEXT,
    "logsStorageKey" TEXT,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NvflareJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvflareSiteStatus" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT,
    "studySiteId" TEXT NOT NULL,
    "siteId" TEXT,
    "nvflareClientName" TEXT NOT NULL,
    "status" "SiteStatus" NOT NULL DEFAULT 'OFFLINE',
    "currentJobId" TEXT,
    "details" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NvflareSiteStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NvflareJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "studySiteId" TEXT,
    "eventType" "NvflareJobEventType" NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NvflareJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteLogArtifact" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "studySiteId" TEXT,
    "siteId" TEXT,
    "nvflareJobId" TEXT,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "retainedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteLogArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudySite_siteId_key" ON "StudySite"("siteId");

-- CreateIndex
CREATE INDEX "StudySite_organizationId_idx" ON "StudySite"("organizationId");

-- CreateIndex
CREATE INDEX "StudySite_studyId_participationStatus_idx" ON "StudySite"("studyId", "participationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "StudySite_studyId_code_key" ON "StudySite"("studyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SiteResourceProfile_studySiteId_key" ON "SiteResourceProfile"("studySiteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDataProfile_studySiteId_key" ON "SiteDataProfile"("studySiteId");

-- CreateIndex
CREATE INDEX "SiteMember_userId_role_idx" ON "SiteMember"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "SiteMember_studySiteId_userId_role_key" ON "SiteMember"("studySiteId", "userId", "role");

-- CreateIndex
CREATE INDEX "SiteReadinessCheck_studySiteId_createdAt_idx" ON "SiteReadinessCheck"("studySiteId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteReadinessCheck_status_idx" ON "SiteReadinessCheck"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineTemplate_templateKey_key" ON "PipelineTemplate"("templateKey");

-- CreateIndex
CREATE INDEX "PipelineTemplate_framework_active_idx" ON "PipelineTemplate"("framework", "active");

-- CreateIndex
CREATE INDEX "PipelineProject_studyId_status_idx" ON "PipelineProject"("studyId", "status");

-- CreateIndex
CREATE INDEX "PipelineVersion_approvalStatus_validationStatus_idx" ON "PipelineVersion"("approvalStatus", "validationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineVersion_projectId_version_key" ON "PipelineVersion"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineVersion_projectId_gitCommit_key" ON "PipelineVersion"("projectId", "gitCommit");

-- CreateIndex
CREATE INDEX "AgentProposal_projectId_status_idx" ON "AgentProposal"("projectId", "status");

-- CreateIndex
CREATE INDEX "CIValidationRun_status_startedAt_idx" ON "CIValidationRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "CIValidationRun_pipelineVersionId_idx" ON "CIValidationRun"("pipelineVersionId");

-- CreateIndex
CREATE INDEX "NvflareDeployment_studyId_active_idx" ON "NvflareDeployment"("studyId", "active");

-- CreateIndex
CREATE INDEX "NvflareJob_studyId_status_idx" ON "NvflareJob"("studyId", "status");

-- CreateIndex
CREATE INDEX "NvflareJob_nvflareJobId_idx" ON "NvflareJob"("nvflareJobId");

-- CreateIndex
CREATE INDEX "NvflareSiteStatus_studySiteId_observedAt_idx" ON "NvflareSiteStatus"("studySiteId", "observedAt");

-- CreateIndex
CREATE INDEX "NvflareSiteStatus_deploymentId_status_idx" ON "NvflareSiteStatus"("deploymentId", "status");

-- CreateIndex
CREATE INDEX "NvflareJobEvent_jobId_createdAt_idx" ON "NvflareJobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "NvflareJobEvent_studyId_eventType_idx" ON "NvflareJobEvent"("studyId", "eventType");

-- CreateIndex
CREATE INDEX "SiteLogArtifact_studyId_createdAt_idx" ON "SiteLogArtifact"("studyId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteLogArtifact_studySiteId_createdAt_idx" ON "SiteLogArtifact"("studySiteId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteLogArtifact_nvflareJobId_idx" ON "SiteLogArtifact"("nvflareJobId");

-- AddForeignKey
ALTER TABLE "StudySite" ADD CONSTRAINT "StudySite_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySite" ADD CONSTRAINT "StudySite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySite" ADD CONSTRAINT "StudySite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteResourceProfile" ADD CONSTRAINT "SiteResourceProfile_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDataProfile" ADD CONSTRAINT "SiteDataProfile_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMember" ADD CONSTRAINT "SiteMember_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMember" ADD CONSTRAINT "SiteMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteReadinessCheck" ADD CONSTRAINT "SiteReadinessCheck_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteReadinessCheck" ADD CONSTRAINT "SiteReadinessCheck_checkedById_fkey" FOREIGN KEY ("checkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineTemplate" ADD CONSTRAINT "PipelineTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineProject" ADD CONSTRAINT "PipelineProject_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineProject" ADD CONSTRAINT "PipelineProject_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PipelineTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineVersion" ADD CONSTRAINT "PipelineVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PipelineProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineVersion" ADD CONSTRAINT "PipelineVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PipelineTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineVersion" ADD CONSTRAINT "PipelineVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PipelineProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CIValidationRun" ADD CONSTRAINT "CIValidationRun_pipelineVersionId_fkey" FOREIGN KEY ("pipelineVersionId") REFERENCES "PipelineVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CIValidationRun" ADD CONSTRAINT "CIValidationRun_agentProposalId_fkey" FOREIGN KEY ("agentProposalId") REFERENCES "AgentProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareDeployment" ADD CONSTRAINT "NvflareDeployment_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJob" ADD CONSTRAINT "NvflareJob_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJob" ADD CONSTRAINT "NvflareJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "NvflareDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJob" ADD CONSTRAINT "NvflareJob_pipelineVersionId_fkey" FOREIGN KEY ("pipelineVersionId") REFERENCES "PipelineVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJob" ADD CONSTRAINT "NvflareJob_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareSiteStatus" ADD CONSTRAINT "NvflareSiteStatus_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "NvflareDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareSiteStatus" ADD CONSTRAINT "NvflareSiteStatus_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareSiteStatus" ADD CONSTRAINT "NvflareSiteStatus_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJobEvent" ADD CONSTRAINT "NvflareJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "NvflareJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJobEvent" ADD CONSTRAINT "NvflareJobEvent_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NvflareJobEvent" ADD CONSTRAINT "NvflareJobEvent_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteLogArtifact" ADD CONSTRAINT "SiteLogArtifact_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteLogArtifact" ADD CONSTRAINT "SiteLogArtifact_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteLogArtifact" ADD CONSTRAINT "SiteLogArtifact_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteLogArtifact" ADD CONSTRAINT "SiteLogArtifact_nvflareJobId_fkey" FOREIGN KEY ("nvflareJobId") REFERENCES "NvflareJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
