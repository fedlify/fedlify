-- CreateTable
CREATE TABLE "RequirementResponse" (
    "id" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "respondedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequirementResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequirementResponse_studyId_idx" ON "RequirementResponse"("studyId");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementResponse_studyId_requirementId_key" ON "RequirementResponse"("studyId", "requirementId");

-- AddForeignKey
ALTER TABLE "RequirementResponse" ADD CONSTRAINT "RequirementResponse_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "Study"("id") ON DELETE CASCADE ON UPDATE CASCADE;
