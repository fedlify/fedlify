-- Registry model: per-study Harbor projects and per-site pull robots. Additive only: new enums and two new tables.
-- No existing table or column changes, so rollback needs no revert. No column holds a robot secret.
CREATE TYPE "RegistryProjectStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "RegistryRobotPurpose" AS ENUM ('SITE_PULL');
CREATE TYPE "RegistryRobotStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKING', 'DELETED');

CREATE TABLE "RegistryProject" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RegistryProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "quotaBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "RegistryProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistryRobot" (
    "id" TEXT NOT NULL,
    "registryProjectId" TEXT NOT NULL,
    "studySiteId" TEXT,
    "siteJoinPackageId" TEXT,
    "purpose" "RegistryRobotPurpose" NOT NULL DEFAULT 'SITE_PULL',
    "harborRobotId" INTEGER,
    "harborName" TEXT NOT NULL,
    "status" "RegistryRobotStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "RegistryRobot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistryProject_studyId_key" ON "RegistryProject"("studyId");
CREATE UNIQUE INDEX "RegistryProject_name_key" ON "RegistryProject"("name");
CREATE INDEX "RegistryRobot_studySiteId_status_idx" ON "RegistryRobot"("studySiteId", "status");
CREATE INDEX "RegistryRobot_status_createdAt_idx" ON "RegistryRobot"("status", "createdAt");
CREATE INDEX "RegistryRobot_registryProjectId_idx" ON "RegistryRobot"("registryProjectId");

ALTER TABLE "RegistryRobot" ADD CONSTRAINT "RegistryRobot_registryProjectId_fkey" FOREIGN KEY ("registryProjectId") REFERENCES "RegistryProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
