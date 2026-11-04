-- Workspace assistant proposals: structured file changes a human accepts as one Gitea commit.
ALTER TYPE "AgentProposalStatus" ADD VALUE IF NOT EXISTS 'PROPOSED';
ALTER TYPE "AgentProposalStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "AgentProposalStatus" ADD VALUE IF NOT EXISTS 'STALE';

ALTER TABLE "AgentProposal" ADD COLUMN "title" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "rationale" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "files" JSONB;
ALTER TABLE "AgentProposal" ADD COLUMN "baseCommit" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "contextHash" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "model" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "acceptedById" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "acceptedCommit" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "acceptedPaths" JSONB;
ALTER TABLE "AgentProposal" ADD COLUMN "decidedAt" TIMESTAMP(3);

CREATE INDEX "AgentProposal_projectId_acceptedCommit_idx" ON "AgentProposal"("projectId", "acceptedCommit");
