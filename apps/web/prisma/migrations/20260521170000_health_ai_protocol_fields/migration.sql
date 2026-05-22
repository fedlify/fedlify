-- Health AI core protocol fields inspired by SPIRIT/M11 plus AI/federated-learning governance.
ALTER TABLE "Study"
ADD COLUMN     "studyDesign" TEXT,
ADD COLUMN     "eligibilityCriteria" TEXT,
ADD COLUMN     "primaryEndpointDetails" TEXT,
ADD COLUMN     "analysisPlan" TEXT,
ADD COLUMN     "dataHandlingPlan" TEXT,
ADD COLUMN     "hypothesis" TEXT,
ADD COLUMN     "secondaryObjectives" TEXT,
ADD COLUMN     "secondaryOutcomes" TEXT,
ADD COLUMN     "sampleSizeRationale" TEXT,
ADD COLUMN     "humanAiWorkflow" TEXT,
ADD COLUMN     "fairnessPlan" TEXT,
ADD COLUMN     "disseminationPlan" TEXT;

UPDATE "Study"
SET
  "studyDesign" = COALESCE(
    "studyDesign",
    'Federated health AI validation study using site-local data and governed model training workflows.'
  ),
  "eligibilityCriteria" = COALESCE(
    "eligibilityCriteria",
    CONCAT(
      'Eligible population: ',
      COALESCE("population", 'site-described patient cohorts remain local to each institution'),
      '. Participating sites apply local inclusion and exclusion criteria before contributing to federated training.'
    )
  ),
  "primaryEndpointDetails" = COALESCE(
    "primaryEndpointDetails",
    CONCAT(
      'Primary endpoint/outcome: ',
      COALESCE("primaryOutcome", 'operational readiness and reproducible job execution'),
      '. Measurement is evaluated from approved study outputs without transferring raw participant-level data.'
    )
  ),
  "analysisPlan" = COALESCE(
    "analysisPlan",
    'Analyze federated model outputs and run logs against the primary endpoint using pre-specified metrics; site-level raw data remain local.'
  ),
  "dataHandlingPlan" = COALESCE(
    "dataHandlingPlan",
    'Use federated learning with site-local data only. Fedlify stores governance metadata, pipeline artifacts, logs, and approved aggregate outputs, not raw participant-level clinical datasets.'
  );
