-- CreateEnum
CREATE TYPE "ControlState" AS ENUM ('INTAKE', 'CLASSIFIED', 'QUARANTINED', 'POLICY_AUTHORIZED', 'WORK_ITEM_SIGNED', 'EVIDENCE_ASSEMBLED', 'WORKER_COMPLETED', 'DETERMINISTIC_VERIFIED', 'SEMANTIC_VERIFIED', 'HUMAN_APPROVED', 'EXPORTED', 'STOPPED');

-- CreateEnum
CREATE TYPE "StopCondition" AS ENUM ('STOP_1_INTAKE', 'STOP_2_EVIDENCE', 'STOP_3_READINESS', 'STOP_4_DETERMINISTIC_VERIFICATION', 'STOP_5_POLICY', 'STOP_6_HUMAN_APPROVAL', 'STOP_7_EXPORT_RUNTIME');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('DRAFT', 'SIGNED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "EvidenceClassification" AS ENUM ('CURATED', 'UNTRUSTED', 'SENSITIVE', 'QUARANTINED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationKind" AS ENUM ('DETERMINISTIC', 'SEMANTIC');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ApprovalBindingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvalidationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "QuarantineStatus" AS ENUM ('HELD', 'RELEASED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProbeRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProbeDisposition" AS ENUM ('PASS', 'WRONG_LAYER', 'NOT_BLOCKED', 'INFRA_FAILURE');

-- CreateEnum
CREATE TYPE "CaseStudyRunStatus" AS ENUM ('DRAFT', 'VALIDATED', 'APPROVED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "SkillContract" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL,
    "requirements" TEXT[],
    "allowedTools" TEXT[],
    "allowedEvidence" TEXT[],
    "outputSchema" JSONB NOT NULL,
    "tokenBudget" INTEGER,
    "timeBudgetSeconds" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "contractHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "SkillContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "skillContractId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "WorkItemStatus" NOT NULL DEFAULT 'DRAFT',
    "controlState" "ControlState" NOT NULL DEFAULT 'INTAKE',
    "stopCondition" "StopCondition",
    "purpose" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "evidenceIds" TEXT[],
    "allowedTools" TEXT[],
    "tokenBudget" INTEGER,
    "timeBudgetSeconds" INTEGER,
    "signature" TEXT,
    "signatureKeyId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactProposal" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "workItemId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "status" "FactStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFact" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "proposalId" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "version" INTEGER NOT NULL,
    "status" "FactStatus" NOT NULL DEFAULT 'CONFIRMED',
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesId" TEXT,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRecord" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceLocator" TEXT NOT NULL,
    "sourceVersion" TEXT,
    "contentHash" TEXT NOT NULL,
    "classification" "EvidenceClassification" NOT NULL,
    "freshnessExpiresAt" TIMESTAMP(3),
    "containsSensitive" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "classifiedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionRecord" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "decision" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceIds" TEXT[],
    "artifactIds" TEXT[],
    "decisionHash" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactRevision" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "workItemId" TEXT,
    "artifactType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageLocator" TEXT NOT NULL,
    "sourceCommit" TEXT,
    "policyVersion" TEXT NOT NULL,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalBinding" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "artifactRevisionId" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "sourceCommit" TEXT,
    "policyVersion" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "status" "ApprovalBindingStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "workItemId" TEXT,
    "artifactRevisionId" TEXT NOT NULL,
    "kind" "VerificationKind" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifier" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "findings" JSONB,
    "inputHash" TEXT NOT NULL,
    "outputHash" TEXT,
    "modelProfile" TEXT,
    "promptHash" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvenanceEdge" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "fromHash" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "toHash" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvenanceEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DependencyInvalidation" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "InvalidationStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DependencyInvalidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuarantineRecord" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceLocator" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "reasonCodes" TEXT[],
    "status" "QuarantineStatus" NOT NULL DEFAULT 'HELD',
    "metadata" JSONB,
    "quarantinedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuarantineRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportManifest" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "approvalBindingId" TEXT NOT NULL,
    "artifactIds" TEXT[],
    "manifest" JSONB NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signatureKeyId" TEXT NOT NULL,
    "credentialFree" BOOLEAN NOT NULL DEFAULT true,
    "exportedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MutationReceipt" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT,
    "promptHash" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "outputHash" TEXT,
    "artifactRevisionId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "verificationStatus" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeRun" (
    "id" TEXT NOT NULL,
    "studyId" TEXT,
    "suiteVersion" TEXT NOT NULL,
    "suiteHash" TEXT NOT NULL,
    "providerProfile" TEXT NOT NULL,
    "repetition" INTEGER NOT NULL DEFAULT 1,
    "status" "ProbeRunStatus" NOT NULL DEFAULT 'PENDING',
    "sourceManifest" JSONB NOT NULL,
    "summary" JSONB,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeResult" (
    "id" TEXT NOT NULL,
    "probeRunId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "disposition" "ProbeDisposition" NOT NULL,
    "expectedDisposition" TEXT NOT NULL,
    "expectedBlockingLayer" TEXT NOT NULL,
    "observedBlockingLayer" TEXT,
    "expectedStopCondition" TEXT,
    "observedStopCondition" TEXT,
    "criticalEscape" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL,
    "fixtureHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStudyProtocol" (
    "id" TEXT NOT NULL,
    "studyId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "protocolHash" TEXT NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "datasetSchema" JSONB NOT NULL,
    "trainingHospitals" INTEGER[],
    "validationHospital" INTEGER NOT NULL,
    "expectedCounts" JSONB NOT NULL,
    "featureContract" JSONB NOT NULL,
    "preprocessing" JSONB NOT NULL,
    "jobSpecifications" JSONB NOT NULL,
    "status" "CaseStudyRunStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseStudyProtocol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStudyRun" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "status" "CaseStudyRunStatus" NOT NULL DEFAULT 'DRAFT',
    "codeCommit" TEXT,
    "containerImage" TEXT,
    "nvflareJobId" TEXT,
    "resultHash" TEXT,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CaseStudyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStudyMetric" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "hospitalId" INTEGER,
    "split" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "ciLower" DOUBLE PRECISION,
    "ciUpper" DOUBLE PRECISION,
    "baselineValue" DOUBLE PRECISION,
    "difference" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseStudyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillContract_studyId_active_idx" ON "SkillContract"("studyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "SkillContract_studyId_name_version_key" ON "SkillContract"("studyId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SkillContract_contractHash_key" ON "SkillContract"("contractHash");

-- CreateIndex
CREATE INDEX "WorkItem_studyId_status_idx" ON "WorkItem"("studyId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_skillContractId_idx" ON "WorkItem"("skillContractId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_studyId_idempotencyKey_key" ON "WorkItem"("studyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FactProposal_studyId_key_status_idx" ON "FactProposal"("studyId", "key", "status");

-- CreateIndex
CREATE INDEX "FactProposal_workItemId_idx" ON "FactProposal"("workItemId");

-- CreateIndex
CREATE INDEX "ProjectFact_studyId_key_status_idx" ON "ProjectFact"("studyId", "key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFact_studyId_key_version_key" ON "ProjectFact"("studyId", "key", "version");

-- CreateIndex
CREATE INDEX "EvidenceRecord_studyId_classification_idx" ON "EvidenceRecord"("studyId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_studyId_sourceLocator_contentHash_key" ON "EvidenceRecord"("studyId", "sourceLocator", "contentHash");

-- CreateIndex
CREATE INDEX "DecisionRecord_studyId_decisionType_createdAt_idx" ON "DecisionRecord"("studyId", "decisionType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRecord_decisionHash_key" ON "DecisionRecord"("decisionHash");

-- CreateIndex
CREATE INDEX "ArtifactRevision_workItemId_idx" ON "ArtifactRevision"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactRevision_studyId_artifactType_revision_key" ON "ArtifactRevision"("studyId", "artifactType", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactRevision_studyId_contentHash_key" ON "ArtifactRevision"("studyId", "contentHash");

-- CreateIndex
CREATE INDEX "ApprovalBinding_studyId_status_idx" ON "ApprovalBinding"("studyId", "status");

-- CreateIndex
CREATE INDEX "ApprovalBinding_artifactRevisionId_idx" ON "ApprovalBinding"("artifactRevisionId");

-- CreateIndex
CREATE INDEX "VerificationRun_studyId_artifactRevisionId_kind_idx" ON "VerificationRun"("studyId", "artifactRevisionId", "kind");

-- CreateIndex
CREATE INDEX "VerificationRun_workItemId_idx" ON "VerificationRun"("workItemId");

-- CreateIndex
CREATE INDEX "ProvenanceEdge_studyId_fromType_fromId_idx" ON "ProvenanceEdge"("studyId", "fromType", "fromId");

-- CreateIndex
CREATE INDEX "ProvenanceEdge_studyId_toType_toId_idx" ON "ProvenanceEdge"("studyId", "toType", "toId");

-- CreateIndex
CREATE UNIQUE INDEX "ProvenanceEdge_studyId_fromId_toId_relation_key" ON "ProvenanceEdge"("studyId", "fromId", "toId", "relation");

-- CreateIndex
CREATE INDEX "DependencyInvalidation_studyId_status_idx" ON "DependencyInvalidation"("studyId", "status");

-- CreateIndex
CREATE INDEX "DependencyInvalidation_targetType_targetId_idx" ON "DependencyInvalidation"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "QuarantineRecord_studyId_status_idx" ON "QuarantineRecord"("studyId", "status");

-- CreateIndex
CREATE INDEX "ExportManifest_studyId_createdAt_idx" ON "ExportManifest"("studyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExportManifest_manifestHash_key" ON "ExportManifest"("manifestHash");

-- CreateIndex
CREATE INDEX "MutationReceipt_studyId_operation_createdAt_idx" ON "MutationReceipt"("studyId", "operation", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MutationReceipt_studyId_actorUserId_idempotencyKey_key" ON "MutationReceipt"("studyId", "actorUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentExecution_studyId_workItemId_idx" ON "AgentExecution"("studyId", "workItemId");

-- CreateIndex
CREATE INDEX "ProbeRun_studyId_status_idx" ON "ProbeRun"("studyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeRun_suiteHash_providerProfile_repetition_createdAt_key" ON "ProbeRun"("suiteHash", "providerProfile", "repetition", "createdAt");

-- CreateIndex
CREATE INDEX "ProbeResult_probeId_disposition_idx" ON "ProbeResult"("probeId", "disposition");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeResult_probeRunId_probeId_key" ON "ProbeResult"("probeRunId", "probeId");

-- CreateIndex
CREATE INDEX "CaseStudyProtocol_studyId_status_idx" ON "CaseStudyProtocol"("studyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStudyProtocol_protocolHash_key" ON "CaseStudyProtocol"("protocolHash");

-- CreateIndex
CREATE INDEX "CaseStudyRun_status_idx" ON "CaseStudyRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStudyRun_protocolId_algorithm_seed_key" ON "CaseStudyRun"("protocolId", "algorithm", "seed");

-- CreateIndex
CREATE INDEX "CaseStudyMetric_metric_split_idx" ON "CaseStudyMetric"("metric", "split");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStudyMetric_runId_hospitalId_split_metric_key" ON "CaseStudyMetric"("runId", "hospitalId", "split", "metric");

-- AddForeignKey
ALTER TABLE "ProbeResult" ADD CONSTRAINT "ProbeResult_probeRunId_fkey" FOREIGN KEY ("probeRunId") REFERENCES "ProbeRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStudyRun" ADD CONSTRAINT "CaseStudyRun_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "CaseStudyProtocol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStudyMetric" ADD CONSTRAINT "CaseStudyMetric_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CaseStudyRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


