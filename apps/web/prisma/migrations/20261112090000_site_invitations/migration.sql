-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "siteRoles" "SiteRole"[] NOT NULL DEFAULT ARRAY[]::"SiteRole"[],
ADD COLUMN     "studySiteId" TEXT;

-- CreateIndex
CREATE INDEX "Invitation_studySiteId_idx" ON "Invitation"("studySiteId");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_studySiteId_fkey" FOREIGN KEY ("studySiteId") REFERENCES "StudySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
