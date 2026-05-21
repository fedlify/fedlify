ALTER TABLE "PipelineVersion" ADD COLUMN "jobWorkspacePath" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "serverStartupPath" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "adminStartupPath" TEXT;
ALTER TABLE "NvflareDeployment" ADD COLUMN "clientStartupPaths" JSONB;
