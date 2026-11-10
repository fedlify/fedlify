-- AlterTable
ALTER TABLE "AgentProposal" ADD COLUMN     "approvalBindingId" TEXT,
ADD COLUMN     "artifactRevisionId" TEXT,
ADD COLUMN     "decisionRecordId" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "workItemId" TEXT;

-- AlterTable
ALTER TABLE "AgentTurn" ADD COLUMN     "controlState" TEXT,
ADD COLUMN     "stopCondition" TEXT,
ADD COLUMN     "workItemId" TEXT;

-- AlterTable
ALTER TABLE "AgentPlan" ADD COLUMN     "approvalBindingId" TEXT,
ADD COLUMN     "artifactRevisionId" TEXT,
ADD COLUMN     "verificationStatus" TEXT,
ADD COLUMN     "workItemId" TEXT;

-- AlterTable
ALTER TABLE "WorkItem" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- AlterTable
ALTER TABLE "ApprovalBinding" ADD COLUMN     "selfApproved" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "WorkItem_sourceType_sourceId_idx" ON "WorkItem"("sourceType", "sourceId");

