-- AlterTable
ALTER TABLE "SiteJoinPackage" ADD COLUMN     "deploymentId" TEXT,
ADD COLUMN     "imageDigest" TEXT;

-- AlterTable
ALTER TABLE "PipelineVersion" ADD COLUMN     "gitTag" TEXT,
ADD COLUMN     "imageDigest" TEXT,
ADD COLUMN     "imageRef" TEXT,
ADD COLUMN     "publishWorkflowId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NvflareDeployment" ADD COLUMN     "adapterUrl" TEXT,
ADD COLUMN     "clientKitPrefix" TEXT,
ADD COLUMN     "hostname" TEXT,
ADD COLUMN     "imageDigest" TEXT,
ADD COLUMN     "kitGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "namespace" TEXT,
ADD COLUMN     "pipelineVersionId" TEXT,
ADD COLUMN     "provisionedSites" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "NvflareDeployment_hostname_key" ON "NvflareDeployment"("hostname");

