-- AlterTable
ALTER TABLE "RequirementResponse" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "evidenceClass" TEXT,
ADD COLUMN     "sourceNote" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ANSWERED';

-- AlterTable
ALTER TABLE "Study" ADD COLUMN     "specificationConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "specificationConfirmedById" TEXT,
ADD COLUMN     "specificationHash" TEXT;
