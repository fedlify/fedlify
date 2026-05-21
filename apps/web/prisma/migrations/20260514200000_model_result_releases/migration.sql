CREATE TYPE "ModelArtifactKind" AS ENUM ('AGGREGATED_MODEL', 'METRICS', 'LOG', 'META', 'MANIFEST');

CREATE TABLE "NvflareJobResult" (
  "id" TEXT NOT NULL,
  "studyId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "syncedById" TEXT,
  "resultPath" TEXT,
  "storagePrefix" TEXT NOT NULL,
  "checksum" TEXT,
  "modelPath" TEXT,
  "modelShape" JSONB,
  "modelDtype" TEXT,
  "modelSizeBytes" BIGINT NOT NULL DEFAULT 0,
  "manifest" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NvflareJobResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelRelease" (
  "id" TEXT NOT NULL,
  "studyId" TEXT NOT NULL,
  "sourceResultId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "approvedById" TEXT,
  "version" TEXT NOT NULL,
  "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
  "checksum" TEXT,
  "storagePrefix" TEXT NOT NULL,
  "releaseNotes" TEXT,
  "immutable" BOOLEAN NOT NULL DEFAULT false,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModelRelease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelArtifact" (
  "id" TEXT NOT NULL,
  "resultId" TEXT NOT NULL,
  "releaseId" TEXT,
  "kind" "ModelArtifactKind" NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NvflareJobResult_jobId_key" ON "NvflareJobResult"("jobId");
CREATE INDEX "NvflareJobResult_studyId_createdAt_idx" ON "NvflareJobResult"("studyId", "createdAt");
CREATE UNIQUE INDEX "ModelRelease_sourceResultId_key" ON "ModelRelease"("sourceResultId");
CREATE UNIQUE INDEX "ModelRelease_studyId_version_key" ON "ModelRelease"("studyId", "version");
CREATE INDEX "ModelRelease_studyId_status_idx" ON "ModelRelease"("studyId", "status");
CREATE UNIQUE INDEX "ModelArtifact_storageKey_key" ON "ModelArtifact"("storageKey");
CREATE INDEX "ModelArtifact_resultId_idx" ON "ModelArtifact"("resultId");
CREATE INDEX "ModelArtifact_releaseId_idx" ON "ModelArtifact"("releaseId");

ALTER TABLE "NvflareJobResult" ADD CONSTRAINT "NvflareJobResult_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NvflareJobResult" ADD CONSTRAINT "NvflareJobResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "NvflareJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NvflareJobResult" ADD CONSTRAINT "NvflareJobResult_syncedById_fkey" FOREIGN KEY ("syncedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModelRelease" ADD CONSTRAINT "ModelRelease_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelRelease" ADD CONSTRAINT "ModelRelease_sourceResultId_fkey" FOREIGN KEY ("sourceResultId") REFERENCES "NvflareJobResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelRelease" ADD CONSTRAINT "ModelRelease_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ModelRelease" ADD CONSTRAINT "ModelRelease_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModelArtifact" ADD CONSTRAINT "ModelArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "NvflareJobResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModelArtifact" ADD CONSTRAINT "ModelArtifact_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "ModelRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
