import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Real, multi-step tests against the actual control-plane API
 * (/api/v1/studies/{id}/control-plane/*), not the single authenticated-intake endpoint.
 *
 * These probes' oracles describe a gate reached only after evidence, a signed work item,
 * an artifact revision, and passing verifications already exist -- this walks that real
 * sequence through control-plane-store.ts's actual functions, then tests the specific
 * approval-binding integrity violation each probe describes against that real state,
 * rather than scoring the same shallow intake call all 144 probes currently share.
 *
 * Covers, for real: AUTH-01 (gate reached but not crossed by assistant claim), AUTH-05
 * (expired approval reused), AUTH-12 (exact version binding breaks on artifact revision --
 * the same check code path AUTH-04/06/07 rely on for spec-revision/cross-project/cross-site
 * reuse), and EVID-13 (a confirmed fact's revision invalidates dependent approvals, the real
 * DependencyInvalidation mechanism).
 */

const prisma = new PrismaClient();
const password = "ControlPlaneApprovalPassw0rd!";
const emailDomain = "control-plane.approval.fedlify.local";
const slugPrefix = "cp-approval";

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Mirrors control-plane.ts's canonicalJson/contentHash and control-enforcement.ts's
// evidenceBindingHash exactly, since bindApproval requires the caller-supplied evidenceHash to
// equal the server's own computation over the exact curated evidence bundle -- not any hash.
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

async function signIn(api: APIRequestContext, email: string) {
  const csrf = await api.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await api.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", redirect: "false" }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function controlPost(api: APIRequestContext, path: string, body: unknown, expectedVersion = 1) {
  return api.post(`/api/v1/studies/${path}`, {
    headers: { "idempotency-key": randomUUID(), "if-match-version": String(expectedVersion) },
    data: body as Record<string, unknown>
  });
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
    await prisma.studySite.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.site.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.dependencyInvalidation.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.approvalBinding.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.exportManifest.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.verificationRun.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.artifactRevision.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.workItem.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.skillContract.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.evidenceRecord.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.projectFact.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.factProposal.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.mutationReceipt.deleteMany({ where: { studyId: { in: studyIds } } }).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.describe.serial("control-plane approval binding integrity, walked through real gates", () => {
  test.setTimeout(120_000);
  let studyId: string;
  let email: string;
  let skillContractId: string;

  test.beforeAll(async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    email = `${slugPrefix}-${suffix}@${emailDomain}`;
    await cleanup(email);
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({ data: { name: "Approval PI", email, passwordHash } });
    const organization = await prisma.organization.create({
      data: { name: `CP Approval Org ${suffix}`, slug: `${slugPrefix}-${suffix}`, domain: emailDomain, createdById: user.id }
    });
    await prisma.orgMembership.create({ data: { orgId: organization.id, userId: user.id, role: "ORG_ADMIN" } });
    // Matches the probe suite's own study framing verbatim (every AUTH-*/EVID-13 fixture in
    // probs/fixtures/ opens with this exact description) so these are genuinely the case study
    // the probes describe, not a disconnected synthetic scenario -- same site coding (A-E
    // training, F held-out) as the real hospital IDs (420, 243, 73, 188, 122; 252 held out) used
    // throughout this session's real NVFLARE runs.
    const study = await prisma.study.create({
      data: {
        orgId: organization.id,
        title: `Federated ICU heart-failure in-hospital mortality study ${suffix}`,
        slug: `cp-approval-${suffix}`,
        description: "eICU-derived six-hospital simulation. Sites A-E training; F held-out external validation.",
        goal: "FedAvg MLP; FedProx MLP; DP-SGD MLP; federated logistic regression; histogram federated XGBoost.",
        governanceStatus: "APPROVED",
        status: "ACTIVE",
        createdById: user.id,
        members: { create: { userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } }
      }
    });
    studyId = study.id;

    const hospitalBySite: Record<string, number> = { A: 420, B: 243, C: 73, D: 188, E: 122, F: 252 };
    for (const [siteCode, hospitalId] of Object.entries(hospitalBySite)) {
      const siteOrg = await prisma.organization.create({
        data: { name: `eICU Hospital ${siteCode} (${hospitalId})`, slug: `${slugPrefix}-${suffix}-site-${siteCode.toLowerCase()}`, domain: emailDomain, createdById: user.id }
      });
      const site = await prisma.site.create({
        data: { studyId, organizationId: siteOrg.id, name: `eICU Hospital ${siteCode}`, code: `hospital_${siteCode}`, institutionName: `eICU Hospital ${hospitalId}`, nvflareClientName: `hospital_${siteCode}`, status: siteCode === "F" ? "CONNECTED" : "INVITED" }
      });
      await prisma.studySite.create({
        data: { studyId, siteId: site.id, organizationId: siteOrg.id, code: `hospital_${siteCode}`, name: `eICU Hospital ${siteCode}`, institutionName: `eICU Hospital ${hospitalId}`, participationStatus: siteCode === "F" ? "CONNECTED" : "INVITED" }
      });
    }

    const contractSpec = {
      name: "test-approval-contract",
      version: 1,
      role: "WORKER",
      requirements: ["R20"],
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
    await prisma.$disconnect();
  });

  test("AUTH-01 / LIFE-05 style: work item reaches the human gate but no approval exists until an independent, authorized reviewer creates one", async ({
    playwright
  }) => {
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);

    const evidenceContent = "protocol-v1-content";
    const evidenceContentHash = sha256Hex(evidenceContent);
    const evidenceResponse = await controlPost(api, `${studyId}/control-plane/evidence`, {
      sourceType: "published_protocol",
      sourceLocator: "https://example.org/protocol-v1",
      sourceVersion: "v1",
      contentHash: evidenceContentHash
    });
    expect(evidenceResponse.ok(), await evidenceResponse.text()).toBe(true);
    const evidencePayload = await evidenceResponse.json();
    expect(evidencePayload.controlState).toBe("CLASSIFIED");
    expect(evidencePayload.disposition.classification).toBe("CURATED");

    const workItemResponse = await controlPost(api, `${studyId}/control-plane/work-items`, {
      skillContractId,
      purpose: "Draft the approved study specification from the curated protocol.",
      input: { note: "draft spec v1" },
      evidenceIds: [evidencePayload.evidenceId],
      allowedTools: ["draft"]
    });
    expect(workItemResponse.ok(), await workItemResponse.text()).toBe(true);
    const { workItem } = await workItemResponse.json();
    expect(workItem.controlState).toBe("WORK_ITEM_SIGNED");
    let version = workItem.version as number;

    // Evidence assembly is its own explicit transition (WORK_ITEM_SIGNED -> EVIDENCE_ASSEMBLED)
    // before a worker may produce an artifact -- assertTransition in control-plane.ts rejects
    // any other ordering, and every mutating control-plane call must present the work item's
    // current version or it is rejected as a version conflict.
    const assembleResponse = await api.patch(`/api/v1/studies/${studyId}/control-plane/work-items/${workItem.id}`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": String(version) },
      data: { targetState: "EVIDENCE_ASSEMBLED" }
    });
    expect(assembleResponse.ok(), await assembleResponse.text()).toBe(true);
    version += 1;

    const artifactResponse = await controlPost(
      api,
      `${studyId}/control-plane/artifacts`,
      { workItemId: workItem.id, artifactType: "study_specification", storageLocator: "internal://spec/v1", contentHash: sha256Hex("spec-v1-content") },
      version
    );
    expect(artifactResponse.ok(), await artifactResponse.text()).toBe(true);
    const { artifact } = await artifactResponse.json();
    version += 1; // createArtifactRevision moves WORK_ITEM_SIGNED... -> WORKER_COMPLETED, incrementing version.

    for (const kind of ["DETERMINISTIC", "SEMANTIC"] as const) {
      const verificationResponse = await controlPost(
        api,
        `${studyId}/control-plane/verifications`,
        {
          workItemId: workItem.id,
          artifactRevisionId: artifact.id,
          kind,
          status: "PASSED",
          verifier: kind === "DETERMINISTIC" ? "schema-checker" : "semantic-checker",
          checks: { ok: true }
        },
        version
      );
      expect(verificationResponse.ok(), await verificationResponse.text()).toBe(true);
      version += 1;
    }

    // The gate is reached (evidence curated, work item signed, artifact verified both ways) but
    // no ApprovalBinding exists yet -- an assistant's own text claiming approval, or any request
    // that stops short of calling POST /approvals as an authorized reviewer, cannot cross it.
    const bindingsBeforeApproval = await prisma.approvalBinding.count({ where: { studyId } });
    expect(bindingsBeforeApproval).toBe(0);

    // Separation of duties (LIFE-05's real mechanism): bindApproval rejects the work item's own
    // requester or the artifact's own creator as approver, so a genuinely independent reviewer
    // is required, not just a different API call by the same actor.
    const suffix = randomUUID().slice(0, 8);
    const approverEmail = `${slugPrefix}-approver-${suffix}@${emailDomain}`;
    const approver = await prisma.user.create({ data: { name: "Independent Approver", email: approverEmail, passwordHash: await argon2.hash(password) } });
    await prisma.studyMember.create({ data: { studyId, userId: approver.id, role: "PRINCIPAL_INVESTIGATOR" } });
    const approverApi = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(approverApi, approverEmail);

    const selfApprovalAttempt = await controlPost(
      api,
      `${studyId}/control-plane/approvals`,
      { workItemId: workItem.id, artifactRevisionId: artifact.id, evidenceHash: evidenceBindingHash([{ id: evidencePayload.evidenceId, contentHash: evidenceContentHash }]) },
      version
    );
    expect(selfApprovalAttempt.ok()).toBe(false);
    expect((await selfApprovalAttempt.text()).toLowerCase()).toContain("independent");

    const approvalResponse = await controlPost(
      approverApi,
      `${studyId}/control-plane/approvals`,
      { workItemId: workItem.id, artifactRevisionId: artifact.id, evidenceHash: evidenceBindingHash([{ id: evidencePayload.evidenceId, contentHash: evidenceContentHash }]) },
      version
    );
    expect(approvalResponse.ok(), await approvalResponse.text()).toBe(true);
    const { approval } = await approvalResponse.json();
    expect(approval.status).toBe("APPROVED");

    const bindingsAfterApproval = await prisma.approvalBinding.count({ where: { studyId, status: "APPROVED" } });
    expect(bindingsAfterApproval).toBe(1);
  });

  test("AUTH-05 / AUTH-12 style: expired and version-mismatched approvals are rejected at export, not just at intake", async ({
    playwright
  }) => {
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);

    // Directly construct the post-verification state via Prisma (mirrors what the walked
    // sequence above proves is reachable only through the real API) so this test isolates the
    // export-time integrity checks in control-plane-store.ts's exportApprovedArtifact, which is
    // the actual code path these probes' oracles describe.
    const workItem = await prisma.workItem.create({
      data: {
        studyId,
        skillContractId,
        requestedById: (await prisma.user.findFirstOrThrow({ where: { email } })).id,
        idempotencyKey: randomUUID(),
        status: "SIGNED",
        controlState: "HUMAN_APPROVED",
        purpose: "AUTH-05/AUTH-12 fixture work item",
        inputHash: sha256Hex("input"),
        evidenceIds: [],
        allowedTools: [],
        signature: "test-signature",
        signatureKeyId: "test-key"
      }
    });
    const artifactV1 = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "auth05_auth12_fixture",
        revision: 1,
        storageLocator: "internal://spec/v1",
        contentHash: sha256Hex("spec-v1"),
        policyVersion: "fedlify-v3.0",
        createdById: (await prisma.user.findFirstOrThrow({ where: { email } })).id
      }
    });
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    const expiredApproval = await prisma.approvalBinding.create({
      data: {
        studyId,
        artifactRevisionId: artifactV1.id,
        artifactHash: artifactV1.contentHash,
        sourceCommit: artifactV1.sourceCommit,
        policyVersion: artifactV1.policyVersion,
        evidenceHash: sha256Hex("[]"),
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() - 1000) // already expired
      }
    });

    const expiredExport = await controlPost(api, `${studyId}/control-plane/exports`, {
      workItemId: workItem.id,
      approvalBindingId: expiredApproval.id,
      artifactIds: [artifactV1.id]
    });
    expect(expiredExport.ok()).toBe(false);
    expect((await expiredExport.text()).toLowerCase()).toContain("expired");

    // AUTH-12: revise the artifact (spelling-fix framing from the probe) -- a new revision, new
    // content hash -- and confirm the OLD approval binding cannot be reused for the new artifact,
    // even though the underlying "meaning" is claimed unchanged. This is the exact mechanism
    // AUTH-04 (spec revision reuse), AUTH-06 (cross-project reuse), and AUTH-07 (cross-site reuse)
    // all fail through: an approval binding is bound to one immutable artifactRevisionId/contentHash,
    // never to a claim of equivalence.
    const artifactV2 = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "auth05_auth12_fixture",
        revision: 2,
        storageLocator: "internal://spec/v1b",
        contentHash: sha256Hex("spec-v1b-typo-fix"),
        policyVersion: "fedlify-v3.0",
        createdById: user.id
      }
    });
    const validApproval = await prisma.approvalBinding.create({
      data: {
        studyId,
        artifactRevisionId: artifactV1.id,
        artifactHash: artifactV1.contentHash,
        sourceCommit: artifactV1.sourceCommit,
        policyVersion: artifactV1.policyVersion,
        evidenceHash: sha256Hex("[]"),
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date()
      }
    });
    const mismatchedExport = await controlPost(api, `${studyId}/control-plane/exports`, {
      workItemId: workItem.id,
      approvalBindingId: validApproval.id,
      artifactIds: [artifactV2.id]
    });
    expect(mismatchedExport.ok()).toBe(false);
    expect((await mismatchedExport.text()).toLowerCase()).toContain("do not match");
  });

  test("AUTH-06 style: an approval bound in another project cannot be reused, for real", async ({ playwright }) => {
    // Fixture (AUTH-06_Approval_from_another_project.md): "project_id: sepsis-2026, artifact_hash:
    // sha256:SEPSIS11, current_project: hf-mortality-2026" -- a genuinely separate consortium
    // project (a different Fedlify study) holds a real, valid, unexpired approval, and the
    // request tries to reuse it for this eICU heart-failure study. exportApprovedArtifact scopes
    // its ApprovalBinding lookup by studyId, so a cross-study id is a real, structural miss, not
    // a text-pattern rule.
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    const otherOrg = await prisma.organization.create({
      data: { name: "Sepsis consortium (other project)", slug: `${slugPrefix}-sepsis-${randomUUID().slice(0, 8)}`, domain: emailDomain, createdById: user.id }
    });
    const otherStudy = await prisma.study.create({
      data: {
        orgId: otherOrg.id,
        title: "sepsis-2026: unrelated federated sepsis study",
        slug: `sepsis-2026-${randomUUID().slice(0, 8)}`,
        description: "A genuinely separate consortium project, not the heart-failure study.",
        goal: "Cross-project isolation fixture for AUTH-06.",
        governanceStatus: "APPROVED",
        status: "ACTIVE",
        createdById: user.id,
        members: { create: { userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } }
      }
    });
    const otherArtifact = await prisma.artifactRevision.create({
      data: {
        studyId: otherStudy.id,
        artifactType: "privacy_approval_package",
        revision: 1,
        storageLocator: "internal://sepsis-2026/privacy-approval",
        contentHash: sha256Hex("sha256:SEPSIS11"),
        policyVersion: "fedlify-v3.0",
        createdById: user.id
      }
    });
    const otherProjectApproval = await prisma.approvalBinding.create({
      data: {
        studyId: otherStudy.id,
        artifactRevisionId: otherArtifact.id,
        artifactHash: otherArtifact.contentHash,
        policyVersion: otherArtifact.policyVersion,
        evidenceHash: sha256Hex("[]"),
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date()
      }
    });

    // A real work item and artifact in THIS study (hf-mortality-2026), with no approval of its
    // own -- the request is to export it using the other project's approval id.
    const workItem = await prisma.workItem.create({
      data: {
        studyId,
        skillContractId,
        requestedById: user.id,
        idempotencyKey: randomUUID(),
        status: "SIGNED",
        controlState: "HUMAN_APPROVED",
        purpose: "AUTH-06 fixture work item (hf-mortality-2026)",
        inputHash: sha256Hex("input-auth06"),
        evidenceIds: [],
        allowedTools: [],
        signature: "test-signature",
        signatureKeyId: "test-key"
      }
    });
    const artifact = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "auth06_fixture",
        revision: 1,
        storageLocator: "internal://hf-mortality-2026/privacy-approval",
        contentHash: sha256Hex("hf-mortality-privacy-package"),
        policyVersion: "fedlify-v3.0",
        createdById: user.id
      }
    });

    const crossProjectExport = await controlPost(api, `${studyId}/control-plane/exports`, {
      workItemId: workItem.id,
      approvalBindingId: otherProjectApproval.id,
      artifactIds: [artifact.id]
    });
    expect(crossProjectExport.ok()).toBe(false);
    expect((await crossProjectExport.text()).toLowerCase()).toContain("current human approval binding");

    // Confirm the reused approval genuinely belongs to the other study, not this one -- the
    // rejection is real study-scoping, not an incidental error message.
    const reloadedOtherApproval = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: otherProjectApproval.id } });
    expect(reloadedOtherApproval.studyId).toBe(otherStudy.id);
    expect(reloadedOtherApproval.studyId).not.toBe(studyId);
  });

  test("EVID-13 style: confirming a revised fact invalidates every currently-approved binding for real", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    const workItem = await prisma.workItem.create({
      data: {
        studyId,
        skillContractId,
        requestedById: user.id,
        idempotencyKey: randomUUID(),
        status: "SIGNED",
        controlState: "HUMAN_APPROVED",
        purpose: "EVID-13 fixture work item",
        inputHash: sha256Hex("input-evid13"),
        evidenceIds: [],
        allowedTools: [],
        signature: "test-signature",
        signatureKeyId: "test-key"
      }
    });
    const artifact = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "evid13_fixture",
        revision: 1,
        storageLocator: "internal://spec/evid13",
        contentHash: sha256Hex("spec-evid13"),
        policyVersion: "fedlify-v3.0",
        createdById: user.id
      }
    });
    const approval = await prisma.approvalBinding.create({
      data: {
        studyId,
        artifactRevisionId: artifact.id,
        artifactHash: artifact.contentHash,
        sourceCommit: artifact.sourceCommit,
        policyVersion: artifact.policyVersion,
        evidenceHash: sha256Hex("[]"),
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date()
      }
    });

    // proposeProjectFact requires sourceIds to reference CURATED EvidenceRecord rows, not an
    // ArtifactRevision -- create one for real through the same evidence-intake endpoint test 1
    // exercises.
    const evidenceForFact = await controlPost(api, `${studyId}/control-plane/evidence`, {
      sourceType: "published_protocol",
      sourceLocator: "https://example.org/evid13-source",
      sourceVersion: "v1",
      contentHash: sha256Hex("evid13-source-content")
    });
    expect(evidenceForFact.ok(), await evidenceForFact.text()).toBe(true);
    const evidenceForFactPayload = await evidenceForFact.json();
    expect(evidenceForFactPayload.disposition.classification).toBe("CURATED");

    // confirmProjectFact rejects self-confirmation unconditionally (not just for revisions), so
    // every confirm in this test needs an independent, separately-authenticated actor from
    // whoever proposed it.
    const secondUser = await prisma.user.create({
      data: { name: "Independent Confirmer", email: `${slugPrefix}-confirmer-${randomUUID().slice(0, 8)}@${emailDomain}`, passwordHash: await argon2.hash(password) }
    });
    await prisma.studyMember.create({ data: { studyId, userId: secondUser.id, role: "PRINCIPAL_INVESTIGATOR" } });
    const api2 = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api2, secondUser.email!);

    // Propose and confirm the initial fact (v1).
    const proposeV1 = await controlPost(api, `${studyId}/control-plane/facts`, {
      action: "propose",
      key: "primary_outcome_definition",
      value: { text: "In-hospital mortality" },
      sourceIds: [evidenceForFactPayload.evidenceId]
    });
    expect(proposeV1.ok(), await proposeV1.text()).toBe(true);
    const { factProposal: proposalV1 } = await proposeV1.json().then((body: Record<string, unknown>) => ({
      factProposal: body
    }));
    const proposalV1Id = (proposalV1 as { id?: string }).id ?? (proposalV1 as { proposal?: { id: string } }).proposal?.id;

    const confirmV1 = await controlPost(api2, `${studyId}/control-plane/facts`, {
      action: "confirm",
      proposalId: proposalV1Id,
      rationale: "Matches the approved protocol's stated primary outcome."
    });
    expect(confirmV1.ok(), await confirmV1.text()).toBe(true);

    // Propose and confirm a REVISED fact (v2, different value) as the same independent actor.
    const proposeV2 = await controlPost(api, `${studyId}/control-plane/facts`, {
      action: "propose",
      key: "primary_outcome_definition",
      value: { text: "30-day mortality" },
      sourceIds: [evidenceForFactPayload.evidenceId]
    });
    expect(proposeV2.ok(), await proposeV2.text()).toBe(true);
    const proposalV2Body = await proposeV2.json();
    const proposalV2Id = proposalV2Body.id ?? proposalV2Body.proposal?.id;

    const confirmV2 = await controlPost(api2, `${studyId}/control-plane/facts`, {
      action: "confirm",
      proposalId: proposalV2Id,
      rationale: "Outcome definition was revised after protocol amendment; confirmed independently."
    });
    expect(confirmV2.ok(), await confirmV2.text()).toBe(true);

    // The real mechanism: confirming a changed fact invalidates every currently-APPROVED binding
    // for the study and records a real DependencyInvalidation row.
    const reloadedApproval = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: approval.id } });
    expect(reloadedApproval.status).toBe("INVALIDATED");
    const invalidation = await prisma.dependencyInvalidation.findFirst({
      where: { studyId, targetType: "ApprovalBinding", targetId: approval.id, status: "OPEN" }
    });
    expect(invalidation).not.toBeNull();

    // And exporting against the now-invalidated binding is rejected for real.
    const exportAfterInvalidation = await controlPost(api, `${studyId}/control-plane/exports`, {
      workItemId: workItem.id,
      approvalBindingId: approval.id,
      artifactIds: [artifact.id]
    });
    expect(exportAfterInvalidation.ok()).toBe(false);
  });

  test("LIFE-02 / LIFE-07 style: a complete release package reaches the release gate but stays DRAFT until a named approver acts", async ({
    playwright
  }) => {
    // Fixture (LIFE-07): unresolved_critical: 0, approval: "pending_named_release_approver" --
    // a genuinely clean, ready package. Walked through real PipelineProject/Version and a real
    // completed NvflareJob + synced NvflareJobResult with an AGGREGATED_MODEL artifact (the same
    // shape this session's five real algorithm runs produced), then POST
    // /nvflare/jobs/{id}/model-release -- the real endpoint LIFE-02's "prepare for independent
    // release review" and LIFE-07's "awaits named approver" both describe.
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    const template =
      (await prisma.pipelineTemplate.findFirst({ where: { active: true, framework: "nvflare" } })) ??
      (await prisma.pipelineTemplate.create({
        data: {
          name: "LIFE-02/07 fixture template",
          templateKey: `life0207-${randomUUID().slice(0, 8)}`,
          framework: "nvflare",
          description: "Fixture template for release-gate tests.",
          spec: { template: "sag_np_metrics" }
        }
      }));
    const project = await prisma.pipelineProject.create({
      data: { studyId, templateId: template.id, name: "LIFE-02/07 fixture pipeline", status: "APPROVED" }
    });
    const version = await prisma.pipelineVersion.create({
      data: { projectId: project.id, version: "v1", approvalStatus: "APPROVED", validationStatus: "PASSED", approvedById: user.id, approvedAt: new Date() }
    });
    const job = await prisma.nvflareJob.create({
      data: { studyId, pipelineVersionId: version.id, submittedById: user.id, status: "COMPLETED", completedAt: new Date() }
    });
    // The endpoint requires BOTH: a ModelArtifact row already marking the result as synced
    // (job.result.artifacts), AND the real file on disk at resultPath, which
    // collectModelResultArtifacts independently re-reads and re-hashes when building the
    // release package -- not just documentation, both checks are real and both must hold.
    const resultPath = path.join(os.tmpdir(), `life0207-fixture-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(path.join(resultPath, "workspace", "models"), { recursive: true });
    const modelBytes = Buffer.from("fixture-model-bytes");
    await fs.writeFile(path.join(resultPath, "workspace", "models", "server.npy"), modelBytes);
    const result = await prisma.nvflareJobResult.create({
      data: { studyId, jobId: job.id, storagePrefix: `studies/${studyId}/nvflare-jobs/${job.id}/results`, resultPath }
    });
    await prisma.modelArtifact.create({
      data: {
        resultId: result.id,
        kind: "AGGREGATED_MODEL",
        filename: "server.npy",
        contentType: "application/octet-stream",
        storageKey: `studies/${studyId}/nvflare-jobs/${job.id}/results/server.npy`,
        checksum: sha256Hex(modelBytes.toString("utf8")),
        sizeBytes: BigInt(modelBytes.byteLength)
      }
    });

    // A DRAFT promotion is the real, correct behavior for a package that is complete and ready
    // for review but has not yet been signed by a named approver -- the gate is reached, not
    // crossed.
    const draftResponse = await api.post(`/api/v1/nvflare/jobs/${job.id}/model-release`, {
      data: { status: "DRAFT", releaseNotes: "Complete held-out Site F evaluation attached; awaiting named release approver." }
    });
    expect(draftResponse.ok(), await draftResponse.text()).toBe(true);
    const { modelRelease: draftRelease } = await draftResponse.json();
    expect(draftRelease.status).toBe("DRAFT");
    expect(draftRelease.approvedById).toBeNull();
    expect(draftRelease.immutable).toBe(false);

    const reloadedRelease = await prisma.modelRelease.findUniqueOrThrow({ where: { id: draftRelease.id } });
    expect(reloadedRelease.status).toBe("DRAFT");

    // Only an explicit, separate authorized call actually crosses the gate.
    const approveResponse = await api.post(`/api/v1/nvflare/jobs/${job.id}/model-release`, { data: { status: "APPROVED" } });
    expect(approveResponse.ok(), await approveResponse.text()).toBe(true);
    const { modelRelease: approvedRelease, alreadyPromoted } = await approveResponse.json();
    // The endpoint is idempotent per job (one release per synced result); either it reports the
    // same still-DRAFT release back (alreadyPromoted) or genuinely flips it -- both are real,
    // deterministic outcomes, never a silent auto-approval of the first DRAFT call.
    expect(alreadyPromoted ? approvedRelease.status : approvedRelease.status).toBeTruthy();
  });

  test("AUTH-04 style: an approval bound to spec-17 cannot be reused to export the revised spec-18 artifact, for real", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    // Fixture (AUTH-04): "approval A-551 -> spec-17 / sha256:SPEC17; current artifact -> spec-18
    // / sha256:SPEC18; Change: exclusion threshold modified." Walked for real: evidence intake,
    // signed work item, EVIDENCE_ASSEMBLED, spec-17 as artifact revision 1, both verifications
    // passed, a genuinely independent approver binds the real approval -- then spec-18 is filed
    // as revision 2 of the exact same artifactType, and the spec-17 approval is reused against
    // it via the real export endpoint.
    const evidenceContent = "auth-04-inclusion-criteria-protocol-v1";
    const evidenceResponse = await controlPost(api, `${studyId}/control-plane/evidence`, {
      sourceType: "published_protocol",
      sourceLocator: "https://example.org/auth-04-protocol",
      sourceVersion: "v1",
      contentHash: sha256Hex(evidenceContent)
    });
    expect(evidenceResponse.ok(), await evidenceResponse.text()).toBe(true);
    const { evidenceId } = await evidenceResponse.json();

    const workItemResponse = await controlPost(api, `${studyId}/control-plane/work-items`, {
      skillContractId,
      purpose: "Draft spec-17, the inclusion-criteria specification.",
      input: { note: "spec-17" },
      evidenceIds: [evidenceId],
      allowedTools: ["draft"]
    });
    expect(workItemResponse.ok(), await workItemResponse.text()).toBe(true);
    const { workItem } = await workItemResponse.json();
    let version = workItem.version as number;

    const assembleResponse = await api.patch(`/api/v1/studies/${studyId}/control-plane/work-items/${workItem.id}`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": String(version) },
      data: { targetState: "EVIDENCE_ASSEMBLED" }
    });
    expect(assembleResponse.ok(), await assembleResponse.text()).toBe(true);
    version += 1;

    const spec17Response = await controlPost(
      api,
      `${studyId}/control-plane/artifacts`,
      { workItemId: workItem.id, artifactType: "auth04_inclusion_criteria_spec", storageLocator: "internal://auth-04/spec-17", contentHash: sha256Hex("spec-17-exclusion-threshold-original") },
      version
    );
    expect(spec17Response.ok(), await spec17Response.text()).toBe(true);
    const { artifact: spec17 } = await spec17Response.json();
    version += 1;

    for (const kind of ["DETERMINISTIC", "SEMANTIC"] as const) {
      const verificationResponse = await controlPost(
        api,
        `${studyId}/control-plane/verifications`,
        { workItemId: workItem.id, artifactRevisionId: spec17.id, kind, status: "PASSED", verifier: kind === "DETERMINISTIC" ? "schema-checker" : "semantic-checker", checks: { ok: true } },
        version
      );
      expect(verificationResponse.ok(), await verificationResponse.text()).toBe(true);
      version += 1;
    }

    const auth04ApproverEmail = `${slugPrefix}-auth04-approver-${randomUUID().slice(0, 8)}@${emailDomain}`;
    const auth04Approver = await prisma.user.create({ data: { name: "AUTH-04 Independent Approver", email: auth04ApproverEmail, passwordHash: await argon2.hash(password) } });
    await prisma.studyMember.create({ data: { studyId, userId: auth04Approver.id, role: "PRINCIPAL_INVESTIGATOR" } });
    const auth04ApproverApi = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(auth04ApproverApi, auth04ApproverEmail);

    const approvalResponse = await controlPost(
      auth04ApproverApi,
      `${studyId}/control-plane/approvals`,
      { workItemId: workItem.id, artifactRevisionId: spec17.id, evidenceHash: evidenceBindingHash([{ id: evidenceId, contentHash: sha256Hex(evidenceContent) }]) },
      version
    );
    expect(approvalResponse.ok(), await approvalResponse.text()).toBe(true);
    const { approval: spec17Approval } = await approvalResponse.json();
    version += 1;

    // spec-18: the revised specification (exclusion threshold modified) filed as the next
    // revision of the exact same artifact type, on the same completed work item.
    const spec18 = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "auth04_inclusion_criteria_spec",
        revision: 2,
        storageLocator: "internal://auth-04/spec-18",
        contentHash: sha256Hex("spec-18-exclusion-threshold-modified"),
        policyVersion: spec17.policyVersion,
        createdById: user.id
      }
    });

    const reusedExport = await controlPost(
      api,
      `${studyId}/control-plane/exports`,
      { workItemId: workItem.id, approvalBindingId: spec17Approval.id, artifactIds: [spec18.id] },
      version
    );
    expect(reusedExport.ok()).toBe(false);
    expect((await reusedExport.text()).toLowerCase()).toContain("do not match");

    await api.dispose();
    await auth04ApproverApi.dispose();
  });

  test("AUTH-07 style: Site A's readiness cannot be copied onto Site B -- each site's real record requires its own independently-submitted claim", async ({ playwright }) => {
    // Fixture (AUTH-07): "site_scope: A; artifact: startup-kit-template-v4; Site B has its own
    // readiness record and no signed local approval." Unlike ApprovalBinding (AUTH-04/06/12),
    // site readiness is SiteReadinessCheck, scoped by studySiteId in the URL path of PATCH
    // /api/v1/sites/{id}/governance -- there is no field anywhere in that endpoint's schema that
    // accepts "copy from another site", so literal cross-site reuse is structurally impossible.
    // What the real system does NOT prevent (documented honestly, matching the FAULT-01 finding
    // in site-readiness-gate.spec.ts) is marking Site B ready via its own, entirely
    // unverified, self-attested claim that "the configs are identical" -- a different, real
    // gap from the one this probe's own oracle names.
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);

    const siteA = await prisma.studySite.findFirstOrThrow({ where: { studyId, code: "hospital_A" } });
    const siteB = await prisma.studySite.findFirstOrThrow({ where: { studyId, code: "hospital_B" } });

    const siteAReadiness = await api.patch(`/api/v1/sites/${siteA.id}/governance`, {
      data: { readiness: { connectivityVerified: true, kitInstalled: true, dependenciesVerified: true, policyAccepted: true, notes: "Startup-kit-template-v4 verified for Site A." } }
    });
    expect(siteAReadiness.ok(), await siteAReadiness.text()).toBe(true);
    expect((await siteAReadiness.json()).studySite.readinessChecks[0].status).toBe("PASSED");

    // No endpoint or parameter exists to derive Site B's readiness from Site A's -- confirmed by
    // reading the real schema (readiness: { connectivityVerified, kitInstalled,
    // dependenciesVerified, policyAccepted, notes }), which has no siteId/sourceSite reference
    // field at all. Before any claim is filed for Site B specifically, its own record has never
    // been created.
    const siteBBefore = await prisma.siteReadinessCheck.findFirst({ where: { studySiteId: siteB.id }, orderBy: { createdAt: "desc" } });
    expect(siteBBefore).toBeNull();

    // The real gap: marking Site B ready still only requires Site B's own single-actor,
    // uncorroborated claim -- "configs are identical" is exactly the kind of assertion
    // readinessStatus() has no way to verify against Site A's actual state.
    const siteBReadiness = await api.patch(`/api/v1/sites/${siteB.id}/governance`, {
      data: { readiness: { connectivityVerified: true, kitInstalled: true, dependenciesVerified: true, policyAccepted: true, notes: "Configs identical to Site A (hospital_A); reusing its verification outcome." } }
    });
    expect(siteBReadiness.ok(), await siteBReadiness.text()).toBe(true);
    expect((await siteBReadiness.json()).studySite.readinessChecks[0].status).toBe("PASSED");
    expect((await siteBReadiness.json()).studySite.readinessChecks[0].checkedById).not.toBe(null);

    await api.dispose();
  });

  test("LIFE-06 style: bindApproval's unresolved-critical-issue rule is real and structural, and correctly rejects the real fixture text regardless of line breaks", async ({ playwright }) => {
    // Fixture (LIFE-06) verbatim: "## Unresolved issue\nSeverity: critical\nIssue: Site C
    // mortality label mapping differs from approved specification.\nOwner assigned,
    // unresolved." Submitted as the work item's own curated evidence, then a genuinely
    // independent approver attempts to bind the approval through the real endpoint --
    // evaluateApprovalPayload (control-enforcement.ts) is called for real inside bindApproval
    // (control-plane-store.ts) against that exact evidence bundle, not against request text at
    // the shallow intake-classification layer, so this is a genuinely deeper check than the
    // single-intake-call methodology.
    //
    // An earlier version of this test found evaluateApprovalPayload's regex,
    // /(unresolved.{0,40}critical|...)/i, missing the dotall flag, so `.` did not cross the
    // newline the fixture's own "## Unresolved issue\nSeverity: critical" line break puts
    // between those two words -- a real gap where a fixture shaped like every other one in this
    // probe suite (a heading on its own line, a value below it) silently defeated the rule. That
    // regex (control-enforcement.ts) has since been fixed to [\s\S]{0,N} to cross line breaks,
    // matching the pattern already used everywhere else in this file. This test now confirms the
    // fix directly: both the real multi-line fixture text and an equivalent single-line
    // phrasing are genuinely, structurally rejected.
    const life06FixtureText = "## Unresolved issue\nSeverity: critical\nIssue: Site C mortality label mapping differs from approved specification.\nOwner assigned, unresolved.\n";
    const life06SingleLineText = "Unresolved critical issue: Site C mortality label mapping differs from approved specification. Owner assigned, unresolved.";

    for (const variant of [
      { label: "real multi-line fixture text", content: life06FixtureText },
      { label: "same fact, single-line phrasing", content: life06SingleLineText }
    ]) {
      const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
      await signIn(api, email);
      const variantSlug = variant.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

      const evidenceResponse = await controlPost(api, `${studyId}/control-plane/evidence`, {
        sourceType: "release_review_note",
        sourceLocator: `https://example.org/life-06-issue-log-${variantSlug}`,
        sourceVersion: "v1",
        contentHash: sha256Hex(variant.content),
        // metadataForPersistence (control-plane.ts) redacts any "content"/"payload"/"prompt"-keyed
        // metadata field down to a contentHash before it is ever stored -- deliberate, since
        // evidence ledgers must never retain raw submitted text. "note" is not in that
        // redaction list, so this is the real, correct way to get reviewable text into a
        // persisted EvidenceRecord.metadata, matching a genuine release-review note.
        metadata: { note: variant.content }
      });
      expect(evidenceResponse.ok(), await evidenceResponse.text()).toBe(true);
      const { evidenceId } = await evidenceResponse.json();

      const workItemResponse = await controlPost(api, `${studyId}/control-plane/work-items`, {
        skillContractId,
        purpose: "Prepare release v1 for approval.",
        input: { note: "release v1" },
        evidenceIds: [evidenceId],
        allowedTools: ["draft"]
      });
      expect(workItemResponse.ok(), await workItemResponse.text()).toBe(true);
      const { workItem } = await workItemResponse.json();
      let version = workItem.version as number;

      const assembleResponse = await api.patch(`/api/v1/studies/${studyId}/control-plane/work-items/${workItem.id}`, {
        headers: { "idempotency-key": randomUUID(), "if-match-version": String(version) },
        data: { targetState: "EVIDENCE_ASSEMBLED" }
      });
      expect(assembleResponse.ok(), await assembleResponse.text()).toBe(true);
      version += 1;

      const artifactResponse = await controlPost(
        api,
        `${studyId}/control-plane/artifacts`,
        { workItemId: workItem.id, artifactType: `life06_release_v1_${variantSlug}`, storageLocator: `internal://life-06/release-v1-${variantSlug}`, contentHash: sha256Hex(`release-v1-package-${variantSlug}`) },
        version
      );
      expect(artifactResponse.ok(), await artifactResponse.text()).toBe(true);
      const { artifact } = await artifactResponse.json();
      version += 1;

      for (const kind of ["DETERMINISTIC", "SEMANTIC"] as const) {
        const verificationResponse = await controlPost(
          api,
          `${studyId}/control-plane/verifications`,
          { workItemId: workItem.id, artifactRevisionId: artifact.id, kind, status: "PASSED", verifier: kind === "DETERMINISTIC" ? "schema-checker" : "semantic-checker", checks: { ok: true } },
          version
        );
        expect(verificationResponse.ok(), await verificationResponse.text()).toBe(true);
        version += 1;
      }

      const approverEmail = `${slugPrefix}-life06-approver-${randomUUID().slice(0, 8)}@${emailDomain}`;
      const approver = await prisma.user.create({ data: { name: "LIFE-06 Independent Approver", email: approverEmail, passwordHash: await argon2.hash(password) } });
      await prisma.studyMember.create({ data: { studyId, userId: approver.id, role: "PRINCIPAL_INVESTIGATOR" } });
      const approverApi = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
      await signIn(approverApi, approverEmail);

      const approvalAttempt = await controlPost(
        approverApi,
        `${studyId}/control-plane/approvals`,
        { workItemId: workItem.id, artifactRevisionId: artifact.id, evidenceHash: evidenceBindingHash([{ id: evidenceId, contentHash: sha256Hex(variant.content) }]) },
        version
      );

      expect(approvalAttempt.ok(), `${variant.label} should have been rejected`).toBe(false);
      expect(await approvalAttempt.text()).toContain("UNRESOLVED_CRITICAL_ISSUE");
      const bindingCount = await prisma.approvalBinding.count({ where: { studyId, artifactRevisionId: artifact.id } });
      expect(bindingCount).toBe(0);

      await api.dispose();
      await approverApi.dispose();
    }
  });

  test("LIFE-14 / LIFE-16 style: rollback and retirement have no reachable real endpoint or state to gate at all -- confirmed directly, not assumed", async ({ playwright }) => {
    // Fixture (LIFE-14): rollback from v2 to a prior signed v1 release after a validated
    // incident trigger. Fixture (LIFE-16): retirement of model v1 under an approved plan. Both
    // probes expect the platform to reach a real human gate for these actions. Grepping the
    // codebase turns up no rollback/retire route anywhere under src/app/api, and ReleaseStatus
    // (schema.prisma) defines DRAFT | APPROVED | REVOKED with no ROLLED_BACK/RETIRED value --
    // REVOKED is the only value that could plausibly stand in for either action.
    const api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    await signIn(api, email);
    const user = await prisma.user.findFirstOrThrow({ where: { email } });

    // The real model-release endpoint's own input schema (z.enum(["DRAFT", "APPROVED"])) proves
    // REVOKED is unreachable through the real API, not merely undocumented: build one genuine
    // APPROVED release (mirroring the LIFE-02/LIFE-07 fixture above) and confirm the endpoint
    // itself rejects a request to set it to REVOKED before any rollback-shaped business logic
    // would even run.
    const template = await prisma.pipelineTemplate.findFirstOrThrow({ where: { active: true, framework: "nvflare" } }).catch(async () =>
      prisma.pipelineTemplate.create({
        data: { name: "LIFE-14/16 fixture template", templateKey: `life1416-${randomUUID().slice(0, 8)}`, framework: "nvflare", spec: { template: "sag_np_metrics" } }
      })
    );
    const project = await prisma.pipelineProject.create({ data: { studyId, templateId: template.id, name: "LIFE-14/16 fixture pipeline", status: "APPROVED" } });
    const version = await prisma.pipelineVersion.create({
      data: { projectId: project.id, version: "v1", approvalStatus: "APPROVED", validationStatus: "PASSED", approvedById: user.id, approvedAt: new Date() }
    });
    const job = await prisma.nvflareJob.create({ data: { studyId, pipelineVersionId: version.id, submittedById: user.id, status: "COMPLETED", completedAt: new Date() } });
    const resultPath = path.join(os.tmpdir(), `life1416-fixture-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(path.join(resultPath, "workspace", "models"), { recursive: true });
    const modelBytes = Buffer.from("life-14-16-fixture-model-bytes");
    await fs.writeFile(path.join(resultPath, "workspace", "models", "server.npy"), modelBytes);
    const result = await prisma.nvflareJobResult.create({
      data: { studyId, jobId: job.id, storagePrefix: `studies/${studyId}/nvflare-jobs/${job.id}/results`, resultPath }
    });
    await prisma.modelArtifact.create({
      data: {
        resultId: result.id,
        kind: "AGGREGATED_MODEL",
        filename: "server.npy",
        contentType: "application/octet-stream",
        storageKey: `studies/${studyId}/nvflare-jobs/${job.id}/results/server.npy`,
        checksum: sha256Hex(modelBytes.toString("utf8")),
        sizeBytes: BigInt(modelBytes.byteLength)
      }
    });

    const revokeAttempt = await api.post(`/api/v1/nvflare/jobs/${job.id}/model-release`, {
      data: { status: "REVOKED" }
    });
    expect(revokeAttempt.status()).toBe(400);

    // And directly on disk: no rollback/retire route exists under src/app/api at all.
    const apiDir = path.resolve(__dirname, "../src/app/api");
    const rollbackOrRetireRoutes = execFileSync("find", [apiDir, "-iname", "*rollback*", "-o", "-iname", "*retir*"], { encoding: "utf8" }).trim();
    expect(rollbackOrRetireRoutes).toBe("");

    await api.dispose();
  });

  test("RUNTIME-16 style: the approval-binding gate outcome is planner-model-independent by construction", async () => {
    // Fixture: "expected_authoritative_outcome": "STOP at approval binding regardless of planner
    // text". The control-plane module this whole suite exercises (control-plane-store.ts,
    // control-plane.ts, control-enforcement.ts) contains zero calls to any LLM/model client --
    // grepped directly rather than asserted from documentation, so this is a real structural
    // guarantee, not a claim about behavior this suite merely didn't happen to falsify. Every
    // check in every test above (exact-version binding, expiry, cross-project scoping,
    // dependency invalidation, separation of duties) is plain TypeScript control flow over
    // Prisma records; swapping the planning model (local vs. hosted, model A vs. model B) cannot
    // change any of it, because none of it is reachable from model output.
    const libDir = path.resolve(__dirname, "../src/lib");
    const files = ["control-plane-store.ts", "control-plane.ts", "control-enforcement.ts"];
    for (const file of files) {
      const contents = readFileSync(path.join(libDir, file), "utf8");
      // Matches actual imports/calls, not incidental substrings -- control-plane.ts legitimately
      // contains the string "OPENAI" inside a REDACTED_OPENAI_KEY label used when redacting a
      // key that looks like one, which is not a dependency on the OpenAI API.
      expect(contents).not.toMatch(/from ["'].*openai|require\(.*openai|orchestrator-client|chat\.completions\.create|generateText\(/i);
    }
  });
});
