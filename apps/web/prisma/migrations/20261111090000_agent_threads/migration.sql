-- Agent threads, turns and plans. Additive only: new enums and tables, nullable columns on "AgentProposal".

-- CreateEnum
CREATE TYPE "AgentThreadStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AgentTurnRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AgentTurnKind" AS ENUM ('MESSAGE', 'QUESTIONS', 'ANSWERS', 'PLAN', 'PLAN_DECISION', 'PROPOSAL', 'NOTICE');

-- CreateEnum
CREATE TYPE "AgentPlanStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'STALE', 'EXECUTED');

-- AlterTable
ALTER TABLE "AgentProposal" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" TEXT,
ADD COLUMN     "threadId" TEXT,
ADD COLUMN     "turnId" TEXT;

-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AgentThreadStatus" NOT NULL DEFAULT 'ACTIVE',
    "mode" TEXT NOT NULL DEFAULT 'ask',
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "lastTurnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTurn" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "AgentTurnRole" NOT NULL,
    "kind" "AgentTurnKind" NOT NULL DEFAULT 'MESSAGE',
    "content" TEXT NOT NULL DEFAULT '',
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'done',
    "actorUserId" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "contextHash" TEXT,
    "baseCommit" TEXT,
    "filePath" TEXT,
    "selection" JSONB,
    "clientTurnId" TEXT,
    "planId" TEXT,
    "proposalId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPlan" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "requirementsHash" TEXT NOT NULL,
    "status" "AgentPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedStepIds" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentThread_projectId_lastTurnAt_idx" ON "AgentThread"("projectId", "lastTurnAt");

-- CreateIndex
CREATE INDEX "AgentThread_createdById_idx" ON "AgentThread"("createdById");

-- CreateIndex
CREATE INDEX "AgentTurn_proposalId_idx" ON "AgentTurn"("proposalId");

-- CreateIndex
CREATE INDEX "AgentTurn_planId_idx" ON "AgentTurn"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTurn_threadId_seq_key" ON "AgentTurn"("threadId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTurn_threadId_clientTurnId_key" ON "AgentTurn"("threadId", "clientTurnId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPlan_threadId_version_key" ON "AgentPlan"("threadId", "version");

-- CreateIndex
CREATE INDEX "AgentProposal_threadId_idx" ON "AgentProposal"("threadId");

-- CreateIndex
CREATE INDEX "AgentProposal_planId_idx" ON "AgentProposal"("planId");

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AgentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PipelineProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTurn" ADD CONSTRAINT "AgentTurn_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
