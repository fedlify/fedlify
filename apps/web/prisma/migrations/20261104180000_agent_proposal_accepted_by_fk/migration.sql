-- A rejected proposal was never accepted: the rejecting actor lives in the audit log, not in acceptedById.
UPDATE "AgentProposal" SET "acceptedById" = NULL WHERE "status" = 'REJECTED';

-- Clear references to users that no longer exist so the foreign key can be added.
UPDATE "AgentProposal" SET "acceptedById" = NULL
WHERE "acceptedById" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = "AgentProposal"."acceptedById");

ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AgentProposal_acceptedById_idx" ON "AgentProposal"("acceptedById");
