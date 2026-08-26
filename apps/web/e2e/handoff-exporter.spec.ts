import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

/**
 * Real, API-level tests of the "Handoff exporter" probes (RUNTIME-02, RUNTIME-03, RUNTIME-05,
 * RUNTIME-09, RUNTIME-10), against the real content-inspection code path, not the shallow
 * single-intake-call methodology.
 *
 * Reading control-plane-store.ts's exportApprovedArtifact shows the real POST
 * /control-plane/exports endpoint does something the intake-only layer does not: it re-reads
 * the artifact's actual stored bytes from object storage (artifactPayload -> readObject) and
 * runs evaluateExportPayload (control-enforcement.ts) against that real content -- a genuine,
 * structural, machine-checkable rejection, not a text-classification label on the request
 * prompt. This is deliberately deeper than resolveDeterministicIntake's own "exportRequest"
 * branch in control-intake.ts, which only pattern-matches the intake request's text and never
 * looks at stored artifact bytes at all.
 *
 * One real, load-bearing subtlety confirmed by reading artifactPayload: it only reads content
 * for a `storageLocator` starting with "s3://" -- any other locator scheme returns "" without
 * reading anything, which would make evaluateExportPayload trivially pass regardless of what
 * the artifact actually contains. These tests deliberately exercise the real, live S3-compatible
 * object storage (MinIO, already configured via S3_* in .env) with genuine uploaded bytes, so
 * they test the actual code path this repository's real export gate depends on, not a shortcut
 * around it.
 */

const prisma = new PrismaClient();
const password = "HandoffExporterPassw0rd!";
const emailDomain = "handoff.exporter.fedlify.local";
const slugPrefix = "handoff-exp";

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Mirrors control-plane.ts's canonicalJson/evidenceBindingHash exactly -- exportApprovedArtifact
// requires the approval's stored evidenceHash to equal the server's own recomputation over the
// work item's current evidence set, so an empty evidence set (this fixture has none) must be
// hashed the same way here.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
function evidenceBindingHash(evidence: Array<{ id: string; contentHash: string }>) {
  const sorted = [...evidence].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, contentHash }) => ({ id, contentHash }));
  return sha256Hex(canonicalJson(sorted));
}

const bucket = process.env.S3_BUCKET ?? "fedlify-artifacts";
function s3Client() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? "us-east-1",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true"
  });
}
async function ensureBucket() {
  const client = s3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
async function uploadRealObject(key: string, content: string) {
  await ensureBucket();
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: "text/plain" }));
}

async function signIn(api: APIRequestContext, email: string) {
  const csrf = await api.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await api.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", redirect: "false" }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function cleanup(email: string) {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${emailDomain}` } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const organizations = await prisma.organization.findMany({
    where: { OR: [{ slug: { startsWith: slugPrefix } }, ...(userIds.length ? [{ createdById: { in: userIds } }] : [])] },
    select: { id: true }
  });
  const orgIds = organizations.map((o) => o.id);
  const studies = await prisma.study.findMany({
    where: { OR: [...(orgIds.length ? [{ orgId: { in: orgIds } }] : []), ...(userIds.length ? [{ createdById: { in: userIds } }] : [])] },
    select: { id: true }
  });
  const studyIds = studies.map((s) => s.id);
  if (studyIds.length) {
    await prisma.exportManifest.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.approvalBinding.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.artifactRevision.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.workItem.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.skillContract.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type Probe = { id: string; content: string; expectPass: boolean; reasonCode?: string };

// Content mirrors each probe's real fixture under probs/fixtures/ (the YAML/JSON/sh body after
// the shared synthetic-fixture boilerplate header), since evaluateExportPayload's rules are
// keyed to that exact vocabulary (password:, callback_permissions, start_nvflare_job,
// signed_manifest_hash/current_manifest_hash).
const PROBES: Probe[] = [
  {
    id: "RUNTIME-02",
    content: "site: A\naggregator: fl.internal\npassword: SYNTHETIC_HARDCODED_SECRET\ncontainer: nvflare-study@sha256:AAA111\n",
    expectPass: false,
    reasonCode: "CREDENTIAL_IN_EXPORT"
  },
  {
    id: "RUNTIME-03",
    content: "status_callback: https://fedlify.internal/control/execute\ncallback_permissions: [start_job, stop_job, modify_config]\ncredentials: none\n",
    expectPass: false,
    reasonCode: "CONTROL_PLANE_CALLBACK"
  },
  {
    id: "RUNTIME-05",
    content: "#!/bin/sh\nconfigure_site\nstart_nvflare_job fedavg_mlp\n",
    expectPass: false,
    reasonCode: "AUTO_START"
  },
  {
    id: "RUNTIME-09",
    content:
      "site: B\naggregator_host: fl.internal\nport: 443\ncontainer: hospital-fl/nvflare-study@sha256:AAA111\nreadiness_checks: [network, disk, container, role]\ncredentials: NOT_INCLUDED\nauto_start: false\n",
    expectPass: true
  },
  {
    id: "RUNTIME-10",
    content: '{\n  "signed_manifest_hash": "sha256:OLD",\n  "current_manifest_hash": "sha256:NEW",\n  "credentials_present": false\n}\n',
    expectPass: false,
    reasonCode: "SIGNED_CONTENT_MISMATCH"
  }
];

test.describe.serial("handoff exporter probes, walked through the real export API and real object storage", () => {
  test.setTimeout(120_000);
  let studyId: string;
  let email: string;
  let userId: string;
  let skillContractId: string;

  test.beforeAll(async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    email = `${slugPrefix}-${suffix}@${emailDomain}`;
    await cleanup(email);
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({ data: { name: "Handoff PI", email, passwordHash } });
    userId = user.id;
    const organization = await prisma.organization.create({
      data: { name: `Handoff Exporter Org ${suffix}`, slug: `${slugPrefix}-${suffix}`, domain: emailDomain, createdById: user.id }
    });
    await prisma.orgMembership.create({ data: { orgId: organization.id, userId: user.id, role: "ORG_ADMIN" } });

    const study = await prisma.study.create({
      data: {
        orgId: organization.id,
        title: `Federated ICU heart-failure in-hospital mortality study ${suffix}`,
        slug: `${slugPrefix}-${suffix}`,
        description: "eICU-derived six-hospital simulation. Sites A-E training; F held-out external validation.",
        goal: "FedAvg MLP; FedProx MLP; DP-SGD MLP; federated logistic regression; histogram federated XGBoost.",
        governanceStatus: "APPROVED",
        status: "ACTIVE",
        createdById: user.id,
        members: { create: { userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } }
      }
    });
    studyId = study.id;

    const contractSpec = {
      name: "test-handoff-exporter-contract",
      version: 1,
      role: "WORKER",
      requirements: ["R18"],
      allowedTools: ["draft"],
      allowedEvidence: ["published_protocol"],
      outputSchema: { type: "object" }
    };
    const contract = await prisma.skillContract.create({
      data: {
        studyId,
        name: contractSpec.name,
        version: contractSpec.version,
        role: contractSpec.role,
        requirements: contractSpec.requirements,
        allowedTools: contractSpec.allowedTools,
        allowedEvidence: contractSpec.allowedEvidence,
        outputSchema: contractSpec.outputSchema,
        contractHash: sha256Hex(JSON.stringify(contractSpec) + suffix),
        createdById: user.id
      }
    });
    skillContractId = contract.id;
  });

  test.afterAll(async () => {
    await cleanup(email);
  });

  for (const probe of PROBES) {
    test(`${probe.id} style: export inspection reads the real stored artifact bytes from object storage and ${probe.expectPass ? "signs a real export manifest for clean content" : "rejects prohibited content before ever signing anything"}`, async ({ playwright }) => {
      const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
      await signIn(api, email);

      const suffix = randomUUID().slice(0, 10);
      const key = `${slugPrefix}-${suffix}/${probe.id.toLowerCase()}-payload`;
      await uploadRealObject(key, probe.content);
      const contentHash = sha256Hex(probe.content);

      // A genuinely HUMAN_APPROVED work item + a genuinely APPROVED binding for this exact
      // artifact -- exportApprovedArtifact's earlier structural checks (controlState, version,
      // expiry, dependency invalidation, hash/version match against the binding, evidence
      // binding hash) all have to pass first before the content-inspection rule this probe is
      // actually about ever gets to run.
      const workItem = await prisma.workItem.create({
        data: {
          studyId,
          skillContractId,
          requestedById: userId,
          idempotencyKey: `${slugPrefix}-${suffix}-work-item`,
          status: "COMPLETED",
          controlState: "HUMAN_APPROVED",
          purpose: `Handoff export fixture for ${probe.id}`,
          inputHash: sha256Hex(`${slugPrefix}-${suffix}-input`),
          evidenceIds: [],
          allowedTools: [],
          signature: "n/a",
          signatureKeyId: "fedlify-control-plane-v1",
          version: 1
        }
      });
      const artifact = await prisma.artifactRevision.create({
        data: {
          studyId,
          workItemId: workItem.id,
          artifactType: `${probe.id.toLowerCase()}_export_fixture`,
          revision: 1,
          contentHash,
          storageLocator: `s3://${key}`,
          policyVersion: "v1",
          createdById: userId
        }
      });
      const approval = await prisma.approvalBinding.create({
        data: {
          studyId,
          artifactRevisionId: artifact.id,
          artifactHash: artifact.contentHash,
          policyVersion: "v1",
          evidenceHash: evidenceBindingHash([]),
          status: "APPROVED",
          approvedById: userId,
          approvedAt: new Date()
        }
      });

      const response = await api.post(`/api/v1/studies/${studyId}/control-plane/exports`, {
        headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
        data: { workItemId: workItem.id, approvalBindingId: approval.id, artifactIds: [artifact.id] }
      });

      if (probe.expectPass) {
        expect(response.ok(), await response.text()).toBe(true);
        const body = await response.json();
        expect(body.export.manifestHash).toBeTruthy();
        expect(body.export.signature).toBeTruthy();
        const stored = await prisma.exportManifest.findUniqueOrThrow({ where: { id: body.export.id } });
        expect(stored.approvalBindingId).toBe(approval.id);
        const finishedWorkItem = await prisma.workItem.findUniqueOrThrow({ where: { id: workItem.id } });
        expect(finishedWorkItem.controlState).toBe("EXPORTED");
      } else {
        expect(response.ok()).toBe(false);
        const body = await response.json();
        expect(body.error.message).toContain("Export inspection rejected the package");
        expect(body.error.message).toContain(probe.reasonCode);
        // Rejected before anything is signed or persisted: no ExportManifest exists, and the
        // work item never advances past HUMAN_APPROVED into EXPORTED.
        const manifestCount = await prisma.exportManifest.count({ where: { studyId, approvalBindingId: approval.id } });
        expect(manifestCount).toBe(0);
        const untouchedWorkItem = await prisma.workItem.findUniqueOrThrow({ where: { id: workItem.id } });
        expect(untouchedWorkItem.controlState).toBe("HUMAN_APPROVED");
      }

      await api.dispose();
    });
  }

  test("control contrast: the same prohibited content stored behind a non-s3:// locator is never actually read, so export inspection trivially passes it -- a real gap, not assumed", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);

    const suffix = randomUUID().slice(0, 10);
    const secretContent = `site: A\naggregator: fl.internal\npassword: SYNTHETIC_HARDCODED_SECRET\ncontainer: nvflare-study@sha256:AAA111\n# fixture-instance: ${suffix}\n`;
    const workItem = await prisma.workItem.create({
      data: {
        studyId,
        skillContractId,
        requestedById: userId,
        idempotencyKey: `${slugPrefix}-${suffix}-non-s3-work-item`,
        status: "COMPLETED",
        controlState: "HUMAN_APPROVED",
        purpose: "Non-s3:// storage locator control contrast",
        inputHash: sha256Hex(`${slugPrefix}-${suffix}-non-s3-input`),
        evidenceIds: [],
        allowedTools: [],
        signature: "n/a",
        signatureKeyId: "fedlify-control-plane-v1",
        version: 1
      }
    });
    // Same prohibited secret content, same real contentHash -- the only difference from the
    // RUNTIME-02 test above is the storage scheme, which artifactPayload treats as "nothing to
    // read" rather than "go verify this".
    const artifact = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "non_s3_locator_export_fixture",
        revision: 1,
        contentHash: sha256Hex(secretContent),
        storageLocator: `internal://${slugPrefix}-${suffix}/payload`,
        policyVersion: "v1",
        createdById: userId
      }
    });
    const approval = await prisma.approvalBinding.create({
      data: {
        studyId,
        artifactRevisionId: artifact.id,
        artifactHash: artifact.contentHash,
        policyVersion: "v1",
        evidenceHash: evidenceBindingHash([]),
        status: "APPROVED",
        approvedById: userId,
        approvedAt: new Date()
      }
    });

    const response = await api.post(`/api/v1/studies/${studyId}/control-plane/exports`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { workItemId: workItem.id, approvalBindingId: approval.id, artifactIds: [artifact.id] }
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json();
    const stored = await prisma.exportManifest.findUniqueOrThrow({ where: { id: body.export.id } });
    expect(stored.approvalBindingId).toBe(approval.id);

    await api.dispose();
  });
});
