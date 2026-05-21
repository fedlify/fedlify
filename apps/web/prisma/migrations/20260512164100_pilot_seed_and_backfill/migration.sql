-- Seed vetted NVFLARE templates used by the production-pilot pipeline workspace.
INSERT INTO "PipelineTemplate" (
  "id",
  "name",
  "templateKey",
  "framework",
  "description",
  "version",
  "spec",
  "active",
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'template-nvflare-cross-silo-fedavg',
    'NVFLARE Cross-silo FedAvg',
    'nvflare-cross-silo-fedavg',
    'nvflare',
    'Baseline cross-silo supervised learning workflow with server aggregation, site-local training, and human release approval.',
    '1.0.0',
    '{"workflow":"fedavg","privacy":["tls-mutual-auth","signed-startup-kits"],"dataBoundary":"site-only","jobType":"training"}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'template-nvflare-federated-evaluation',
    'NVFLARE Federated Evaluation',
    'nvflare-federated-evaluation',
    'nvflare',
    'Site-local model evaluation workflow for measuring cross-institution performance before release decisions.',
    '1.0.0',
    '{"workflow":"federated-evaluation","privacy":["tls-mutual-auth","signed-startup-kits"],"dataBoundary":"site-only","jobType":"evaluation"}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("templateKey") DO NOTHING;

-- Backfill the new governance site entity for participant sites created before the pilot schema.
INSERT INTO "StudySite" (
  "id",
  "studyId",
  "siteId",
  "organizationId",
  "code",
  "name",
  "institutionName",
  "participationStatus",
  "createdAt",
  "updatedAt"
)
SELECT
  CONCAT('studysite-', s."id"),
  s."studyId",
  s."id",
  s."organizationId",
  s."code",
  s."name",
  s."institutionName",
  s."status",
  s."createdAt",
  CURRENT_TIMESTAMP
FROM "Site" s
ON CONFLICT ("studyId", "code") DO NOTHING;

INSERT INTO "SiteResourceProfile" ("id", "studySiteId", "createdAt", "updatedAt")
SELECT CONCAT('resource-', ss."id"), ss."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "StudySite" ss
ON CONFLICT ("studySiteId") DO NOTHING;

INSERT INTO "SiteDataProfile" ("id", "studySiteId", "dataResidency", "createdAt", "updatedAt")
SELECT CONCAT('data-', ss."id"), ss."id", 'site-local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "StudySite" ss
ON CONFLICT ("studySiteId") DO NOTHING;

INSERT INTO "SiteReadinessCheck" (
  "id",
  "studySiteId",
  "connectivityVerified",
  "kitInstalled",
  "dependenciesVerified",
  "policyAccepted",
  "status",
  "notes",
  "createdAt"
)
SELECT
  CONCAT('readiness-', ss."id"),
  ss."id",
  false,
  false,
  false,
  false,
  'PENDING',
  'Pilot readiness checklist initialized during governance migration.',
  CURRENT_TIMESTAMP
FROM "StudySite" ss
WHERE NOT EXISTS (
  SELECT 1 FROM "SiteReadinessCheck" src WHERE src."studySiteId" = ss."id"
);
