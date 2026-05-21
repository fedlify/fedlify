-- Real runtime pilot fields for Gitea-backed pipelines and local Docker NVFLARE deployments.
ALTER TABLE "PipelineProject" ADD COLUMN "giteaOwner" TEXT;
ALTER TABLE "PipelineProject" ADD COLUMN "giteaRepo" TEXT;
ALTER TABLE "PipelineProject" ADD COLUMN "giteaDefaultBranch" TEXT NOT NULL DEFAULT 'main';

ALTER TABLE "AgentProposal" ADD COLUMN "giteaPullRequestNumber" INTEGER;
ALTER TABLE "AgentProposal" ADD COLUMN "giteaHeadCommit" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "giteaBaseBranch" TEXT;

ALTER TABLE "NvflareDeployment" ADD COLUMN "runtimeMode" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "serverAddress" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "adminAddress" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "composeProject" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "workspacePath" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "ports" JSONB;
ALTER TABLE "NvflareDeployment" ADD COLUMN "lastError" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "NvflareDeployment" ADD COLUMN "stoppedAt" TIMESTAMP(3);
