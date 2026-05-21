-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'PLATFORM_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ORG_ADMIN', 'MEMBER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "StudyRole" AS ENUM ('STUDY_OWNER', 'STUDY_COORDINATOR', 'ETHICS_REVIEWER', 'DATA_SCIENTIST', 'SITE_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "StudyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EthicsStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('REQUIREMENTS_PDF', 'ETHICS_APPROVAL', 'DATA_PROCESSING_AGREEMENT', 'SITE_POLICY', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'WARNING', 'BLOCKED');

-- CreateEnum
CREATE TYPE "NeedSubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'DRAFT_READY', 'VALIDATED', 'FAILED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SERVER_KIT', 'SITE_KIT', 'ADMIN_KIT', 'HELM_CHART', 'SOURCE_BUNDLE', 'CHECKSUM_MANIFEST', 'SIGNATURE', 'LOG_BUNDLE');

-- CreateEnum
CREATE TYPE "ComputeMode" AS ENUM ('SITE_LOCAL', 'CENTRAL_SANDBOX');

-- CreateEnum
CREATE TYPE "ComputeRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('INVITED', 'KIT_RELEASED', 'CONNECTED', 'DEGRADED', 'OFFLINE', 'DISABLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "title" TEXT,
    "institution" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMembership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Study" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "StudyStatus" NOT NULL DEFAULT 'DRAFT',
    "defaultStudy" BOOLEAN NOT NULL DEFAULT false,
    "resourcePolicy" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Study_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyMember" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "StudyRole" NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "StudyRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "institutionName" TEXT NOT NULL,
    "nvflareClientName" TEXT NOT NULL,
    "operatorUserId" TEXT,
    "apiTokenHash" TEXT,
    "status" "SiteStatus" NOT NULL DEFAULT 'INVITED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceGrant" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "granteeOrgId" TEXT,
    "granteeUserId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EthicsApproval" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "status" "EthicsStatus" NOT NULL,
    "approvalNumber" TEXT,
    "approvingBody" TEXT,
    "documentId" TEXT,
    "approvedById" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EthicsApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT,
    "scanStatus" "DocumentScanStatus" NOT NULL DEFAULT 'PENDING',
    "extractedText" TEXT,
    "phiWarning" BOOLEAN NOT NULL DEFAULT false,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NeedSubmission" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "status" "NeedSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NeedSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "needSubmissionId" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "inputSummary" TEXT NOT NULL,
    "modelName" TEXT NOT NULL DEFAULT 'nvflare',
    "workflowId" TEXT,
    "gitCommit" TEXT,
    "logsStorageKey" TEXT,
    "validationSummary" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewDecision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineSpec" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "nvflareProjectYaml" TEXT,
    "appTemplate" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitRelease" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "checksum" TEXT,
    "signature" TEXT,
    "storagePrefix" TEXT NOT NULL,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "releaseNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitArtifact" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "siteId" TEXT,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComputeRun" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "releaseId" TEXT,
    "mode" "ComputeMode" NOT NULL,
    "status" "ComputeRunStatus" NOT NULL DEFAULT 'QUEUED',
    "workflowId" TEXT,
    "syntheticOnly" BOOLEAN NOT NULL DEFAULT true,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ComputeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteHeartbeat" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "computeRunId" TEXT,
    "status" "SiteStatus" NOT NULL,
    "version" TEXT,
    "ipHash" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "orgId" TEXT,
    "studyId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrgMembership_userId_role_idx" ON "OrgMembership"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMembership_orgId_userId_key" ON "OrgMembership"("orgId", "userId");

-- CreateIndex
CREATE INDEX "Study_createdById_idx" ON "Study"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Study_orgId_slug_key" ON "Study"("orgId", "slug");

-- CreateIndex
CREATE INDEX "StudyMember_userId_role_idx" ON "StudyMember"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "StudyMember_studyId_userId_role_key" ON "StudyMember"("studyId", "userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_studyId_status_idx" ON "Invitation"("studyId", "status");

-- CreateIndex
CREATE INDEX "Invitation_email_status_idx" ON "Invitation"("email", "status");

-- CreateIndex
CREATE INDEX "Site_organizationId_idx" ON "Site"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_studyId_code_key" ON "Site"("studyId", "code");

-- CreateIndex
CREATE INDEX "EthicsApproval_studyId_status_idx" ON "EthicsApproval"("studyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_studyId_kind_idx" ON "Document"("studyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Document_studyId_kind_version_key" ON "Document"("studyId", "kind", "version");

-- CreateIndex
CREATE INDEX "AgentRun_studyId_status_idx" ON "AgentRun"("studyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineSpec_agentRunId_key" ON "PipelineSpec"("agentRunId");

-- CreateIndex
CREATE INDEX "KitRelease_agentRunId_idx" ON "KitRelease"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "KitRelease_studyId_version_key" ON "KitRelease"("studyId", "version");

-- CreateIndex
CREATE INDEX "KitArtifact_siteId_idx" ON "KitArtifact"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "KitArtifact_releaseId_storageKey_key" ON "KitArtifact"("releaseId", "storageKey");

-- CreateIndex
CREATE INDEX "ComputeRun_studyId_status_idx" ON "ComputeRun"("studyId", "status");

-- CreateIndex
CREATE INDEX "SiteHeartbeat_siteId_createdAt_idx" ON "SiteHeartbeat"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_studyId_createdAt_idx" ON "AuditEvent"("studyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Study" ADD CONSTRAINT "Study_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Study" ADD CONSTRAINT "Study_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyMember" ADD CONSTRAINT "StudyMember_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyMember" ADD CONSTRAINT "StudyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceGrant" ADD CONSTRAINT "ResourceGrant_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicsApproval" ADD CONSTRAINT "EthicsApproval_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicsApproval" ADD CONSTRAINT "EthicsApproval_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeedSubmission" ADD CONSTRAINT "NeedSubmission_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeedSubmission" ADD CONSTRAINT "NeedSubmission_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_needSubmissionId_fkey" FOREIGN KEY ("needSubmissionId") REFERENCES "NeedSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineSpec" ADD CONSTRAINT "PipelineSpec_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitRelease" ADD CONSTRAINT "KitRelease_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitRelease" ADD CONSTRAINT "KitRelease_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitArtifact" ADD CONSTRAINT "KitArtifact_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "KitRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitArtifact" ADD CONSTRAINT "KitArtifact_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeRun" ADD CONSTRAINT "ComputeRun_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeRun" ADD CONSTRAINT "ComputeRun_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputeRun" ADD CONSTRAINT "ComputeRun_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "KitRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteHeartbeat" ADD CONSTRAINT "SiteHeartbeat_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteHeartbeat" ADD CONSTRAINT "SiteHeartbeat_computeRunId_fkey" FOREIGN KEY ("computeRunId") REFERENCES "ComputeRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE SET NULL ON UPDATE CASCADE;
