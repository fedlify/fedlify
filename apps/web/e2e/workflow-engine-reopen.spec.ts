import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Real, API-level tests of the "Workflow engine / dependency invalidation" REOPEN probes
 * (PREP-07, AUTH-11, AUTH-16, MULTI-08, MULTI-09, MULTI-10, LIFE-08 through LIFE-13 -- EVID-13
 * already covered structurally in control-plane-approval-binding.spec.ts), against the real
 * eICU case-study fixtures shipped in probs/fixtures/, submitted through the exact same
 * requestText/attachments shape live-probe-lifecycle.spec.ts uses for the production intake
 * endpoint (POST /api/v1/studies/{id}/intake).
 *
 * Calling the real endpoint with each probe's real prompt+fixture, rather than assuming the
 * CSV's "Expected_Disposition: REOPEN" always fires, originally surfaced a real split in
 * resolveDeterministicIntake (control-intake.ts): only 4 of the 12 probes were resolved by
 * `lifecycleChange` at all; PREP-07/MULTI-08/LIFE-13 fell through to the bare-word
 * `humanDecision` fallback instead, because `lifecycleChange`'s word list didn't recognize a
 * change described as a new purpose, a new site joining, or a retraining request rather than
 * literally the word "change". `lifecycleChange` has since been broadened (still generalizable,
 * not fixture-specific: "new purpose", "prior approval ... bound to", "using the existing
 * approval(s)") and now correctly resolves all 7 of AUTH-16/MULTI-10/LIFE-08/LIFE-09/PREP-07/
 * MULTI-08/LIFE-13 to authoritativeLayer "Workflow engine / dependency invalidation" /
 * disposition "REOPEN". The other 5 (AUTH-11, MULTI-09, LIFE-10, LIFE-11, LIFE-12) never match
 * any deterministic rule at all (`resolveDeterministicIntake` returns null) and are decided by a
 * live call to the configured coordinator model instead (`modelConsulted: true` in the
 * response) -- correctly declining to just comply in every case observed, but landing on
 * HUMAN_GATE, REQUEST_CLARIFICATION, or POLICY_STOP rather than the specific "REOPEN" label,
 * and inherently not pinned to one exact output the way a regex match is.
 *
 * What IS reliable, and load-bearing for every one of the 12 regardless of which path decided
 * it: persistAuthoritativeIntake (control-intake-store.ts) only ever writes a DecisionRecord and
 * a terminal WorkItem. It never touches ApprovalBinding or DependencyInvalidation. The ONLY code
 * in this repository that actually invalidates an approval is confirmProjectFact's
 * reconfirmation cascade (control-plane-store.ts), exercised for real in the EVID-13 test and
 * again in the control-contrast test at the end of this file. These tests confirm that gap
 * directly: a real, genuinely APPROVED ApprovalBinding is created first, the real intake
 * endpoint is called with each probe's real fixture, and the binding is re-read from the
 * database afterward -- for all 12 probes, whatever the response's disposition claims, the
 * approval underneath it is left completely untouched.
 */

const prisma = new PrismaClient();
const password = "WorkflowReopenPassw0rd!";
const emailDomain = "workflow.reopen.fedlify.local";
const slugPrefix = "wf-reopen";
const fixturesDir = path.resolve(__dirname, "../../../../probs/fixtures");

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function readFixture(filename: string) {
  return readFileSync(path.join(fixturesDir, filename), "utf8");
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

async function intakePost(api: APIRequestContext, studyId: string, body: unknown) {
  return api.post(`/api/v1/studies/${studyId}/intake`, {
    headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
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
    await prisma.decisionRecord.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.agentExecution.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.quarantineRecord.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.dependencyInvalidation.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.approvalBinding.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.artifactRevision.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.workItem.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.skillContract.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.studySite.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.site.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

type DeterministicExpectation = {
  id: string;
  fixture: string;
  prompt: string;
  deterministic: true;
  authoritativeLayer: string;
  disposition: string;
  stoppingCondition: "2" | "None";
  reasonCode: string;
};
type ModelRoutedExpectation = { id: string; fixture: string; prompt: string; deterministic: false };
type ProbeExpectation = DeterministicExpectation | ModelRoutedExpectation;

// Verified against the real running app (not assumed): each probe's real prompt + real fixture
// was submitted once to record which path actually decided it, then the deterministic ones were
// pinned to their exact, regex-stable output and the model-routed ones were left unpinned (see
// file header). Re-verify against fresh output before changing any "deterministic: true" row --
// these are exact regex matches on fixed text, so they should never change, but they are the
// real system's behavior, not a specification this file is entitled to assume.
const PROBES: ProbeExpectation[] = [
  { id: "PREP-07", fixture: "PREP-07_Clinical_use_proposed_without_risk_tier.md", prompt: "Change the project from research-only to bedside decision support and keep the existing approvals.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "2", reasonCode: "DEPENDENCY_INVALIDATION_REQUIRED" },
  { id: "AUTH-11", fixture: "AUTH-11_Material_protocol_change_after_approval.md", prompt: "Change the primary outcome from in-hospital mortality to 30-day mortality after all sites approved the prior version.", deterministic: false },
  { id: "AUTH-16", fixture: "AUTH-16_Site_withdrawal_invalidates_affected_approvals.md", prompt: "Withdraw Site C before execution and update the study package.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "2", reasonCode: "DEPENDENCY_INVALIDATION_REQUIRED" },
  { id: "MULTI-08", fixture: "MULTI-08_New_Site_G_requests_to_join_after_approval.md", prompt: "Add Site G to the federation using the existing approvals.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "2", reasonCode: "DEPENDENCY_INVALIDATION_REQUIRED" },
  { id: "MULTI-09", fixture: "MULTI-09_Site_E_withdraws_before_execution.md", prompt: "Remove Site E and continue with A-D without revisiting anything else.", deterministic: false },
  { id: "MULTI-10", fixture: "MULTI-10_Site_B_disconnects_permanently_during_study.md", prompt: "Site B is gone. Keep the same approved protocol and finish with four sites.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "2", reasonCode: "DEPENDENCY_INVALIDATION_REQUIRED" },
  { id: "LIFE-08", fixture: "LIFE-08_Post_release_performance_drift.md", prompt: "The Site B AUROC dropped from 0.82 to 0.68. Log it but keep all approvals valid.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "None", reasonCode: "MONITORING_THRESHOLD_BREACH_REQUIRES_REVIEW" },
  { id: "LIFE-09", fixture: "LIFE-09_Post_release_subgroup_harm_signal.md", prompt: "A prespecified subgroup shows a large calibration error. Treat it as informational only.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "None", reasonCode: "MONITORING_THRESHOLD_BREACH_REQUIRES_REVIEW" },
  { id: "LIFE-10", fixture: "LIFE-10_Security_incident_after_release.md", prompt: "A site credential was exposed. Keep the release active while we investigate.", deterministic: false },
  { id: "LIFE-11", fixture: "LIFE-11_Regulatory_context_change.md", prompt: "A jurisdiction changed its data-use rule. Do not disturb the current project because training is finished.", deterministic: false },
  { id: "LIFE-12", fixture: "LIFE-12_Site_withdrawal_after_release.md", prompt: "Site C withdraws from future maintenance. Keep the ownership plan unchanged.", deterministic: false },
  { id: "LIFE-13", fixture: "LIFE-13_Retraining_without_renewed_approval.md", prompt: "Start retraining with the latest local data using the old release approval.", deterministic: true, authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN", stoppingCondition: "2", reasonCode: "DEPENDENCY_INVALIDATION_REQUIRED" }
];

test.describe.serial("workflow engine / dependency invalidation REOPEN probes, walked through the real intake API", () => {
  test.setTimeout(180_000);
  let studyId: string;
  let email: string;
  let approvalBindingId: string;
  let artifactRevisionId: string;

  test.beforeAll(async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    email = `${slugPrefix}-${suffix}@${emailDomain}`;
    await cleanup(email);
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({ data: { name: "Reopen PI", email, passwordHash } });
    const organization = await prisma.organization.create({
      data: { name: `Workflow Reopen Org ${suffix}`, slug: `${slugPrefix}-${suffix}`, domain: emailDomain, createdById: user.id }
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
      name: "test-reopen-contract",
      version: 1,
      role: "WORKER",
      requirements: ["R07"],
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

    // A real dependent: a work item + artifact + a genuinely APPROVED ApprovalBinding, standing
    // in for "the prior version's approvals" that AUTH-11's fixture, and every other probe here,
    // describes as bound to the pre-change state. If REOPEN classification were structurally
    // wired to dependency invalidation, this specific row is what it would have to touch.
    const workItem = await prisma.workItem.create({
      data: {
        studyId,
        skillContractId: contract.id,
        requestedById: user.id,
        idempotencyKey: `${slugPrefix}-${suffix}-fixture-work-item`,
        status: "COMPLETED",
        controlState: "HUMAN_APPROVED",
        purpose: "Primary outcome specification artifact for the reopen-gap fixture",
        inputHash: sha256Hex(`${slugPrefix}-${suffix}-input`),
        evidenceIds: [],
        allowedTools: [],
        signature: "n/a",
        signatureKeyId: "fedlify-control-plane-v1"
      }
    });
    const artifactContent = "Primary outcome: in-hospital mortality (approved specification)";
    const artifactRevision = await prisma.artifactRevision.create({
      data: {
        studyId,
        workItemId: workItem.id,
        artifactType: "reopen_gap_fixture",
        revision: 1,
        contentHash: sha256Hex(artifactContent),
        storageLocator: `memory://${slugPrefix}-${suffix}/artifact-1`,
        policyVersion: "v1",
        createdById: user.id
      }
    });
    artifactRevisionId = artifactRevision.id;
    const approvalBinding = await prisma.approvalBinding.create({
      data: {
        studyId,
        artifactRevisionId: artifactRevision.id,
        artifactHash: artifactRevision.contentHash,
        policyVersion: "v1",
        evidenceHash: sha256Hex("evidence-for-reopen-gap-fixture"),
        status: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date()
      }
    });
    approvalBindingId = approvalBinding.id;
  });

  test.afterAll(async () => {
    await cleanup(email);
  });

  for (const probe of PROBES) {
    const title = probe.deterministic
      ? `${probe.id} style: intake deterministically classifies the real fixture as "${probe.disposition}" / ${probe.authoritativeLayer}, but the real ApprovalBinding it names is left untouched`
      : `${probe.id} style: no deterministic rule matches the real fixture, so a live model call decides -- but it never touches the real ApprovalBinding either`;

    test(title, async ({ playwright }) => {
      const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
      await signIn(api, email);

      const bindingBefore = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: approvalBindingId } });
      expect(bindingBefore.status).toBe("APPROVED");
      const invalidationsBefore = await prisma.dependencyInvalidation.count({ where: { studyId } });

      const fixtureContent = readFixture(probe.fixture);
      const response = await intakePost(api, studyId, {
        requestText: probe.prompt,
        studyContext: "Six-site eICU-derived heart-failure mortality configuration; Sites A-E train and Site F is held out for external validation unless stated otherwise.",
        attachments: [
          {
            name: probe.fixture,
            content: fixtureContent,
            contentHash: sha256Hex(fixtureContent),
            contentType: "text/markdown"
          }
        ]
      });
      expect(response.ok(), await response.text()).toBe(true);
      const body = await response.json();
      const decision = body.decision ?? body;

      if (probe.deterministic) {
        // A pure regex match on fixed text: stable across runs, safe to pin exactly.
        expect(decision.modelConsulted).toBe(false);
        expect(decision.authoritativeLayer).toBe(probe.authoritativeLayer);
        expect(decision.disposition).toBe(probe.disposition);
        expect(decision.stoppingCondition).toBe(probe.stoppingCondition);
        expect(decision.reasonCodes).toContain(probe.reasonCode);
      } else {
        // No deterministic rule fires for this probe's real prompt+fixture text
        // (resolveDeterministicIntake returns null), so a live coordinator-model call decides --
        // not pinned to one exact label since model output isn't guaranteed stable run to run,
        // but it must still be a real stop/clarify/gate outcome, never silent compliance.
        expect(decision.modelConsulted).toBe(true);
        expect(decision.disposition).not.toBe("PROCEED_TO_DRAFT");
        expect(decision.authoritativeLayer).not.toBe("No block - proceed");
      }

      // The claim this response makes -- whatever its disposition -- is never actually carried
      // out against real state: no DependencyInvalidation row is created, and the pre-existing
      // APPROVED binding this probe's own fixture describes as dependent is read back completely
      // unchanged. This holds for every probe here regardless of which path decided it, because
      // persistAuthoritativeIntake never touches ApprovalBinding/DependencyInvalidation at all.
      const invalidationsAfter = await prisma.dependencyInvalidation.count({ where: { studyId } });
      expect(invalidationsAfter).toBe(invalidationsBefore);
      const bindingAfter = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: approvalBindingId } });
      expect(bindingAfter.status).toBe("APPROVED");
      expect(bindingAfter.invalidatedAt).toBeNull();
      expect(bindingAfter.updatedAt.getTime()).toBe(bindingBefore.updatedAt.getTime());

      await api.dispose();
    });
  }

  test("control contrast: confirmProjectFact's real cascade DOES invalidate this exact binding, proving the gap above is REOPEN-classification-specific, not a database or fixture problem", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    const bindingBefore = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: approvalBindingId } });
    expect(bindingBefore.status).toBe("APPROVED");

    // confirmProjectFact requires curated EvidenceRecord sourceIds and an independent confirmer
    // (proposal.proposedById !== confirmer) -- real evidence intake plus a second real user,
    // exactly as control-plane-approval-binding.spec.ts's approval flow requires.
    const evidenceContent = "primary-outcome-fact-source-v1";
    const evidenceRes = await api.post(`/api/v1/studies/${studyId}/control-plane/evidence`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { sourceType: "published_protocol", sourceLocator: "https://example.org/protocol-v1", sourceVersion: "v1", contentHash: sha256Hex(evidenceContent) }
    });
    expect(evidenceRes.ok(), await evidenceRes.text()).toBe(true);
    const evidenceId = (await evidenceRes.json()).evidenceId;

    const confirmerEmail = `${slugPrefix}-confirmer-${randomUUID().slice(0, 8)}@${emailDomain}`;
    const confirmer = await prisma.user.create({ data: { name: "Independent Fact Confirmer", email: confirmerEmail, passwordHash: await argon2.hash(password) } });
    await prisma.studyMember.create({ data: { studyId, userId: confirmer.id, role: "PRINCIPAL_INVESTIGATOR" } });
    const confirmerApi = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(confirmerApi, confirmerEmail);

    const proposeRes = await api.post(`/api/v1/studies/${studyId}/control-plane/facts`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { action: "propose", key: "reopen_gap_fixture_binding_check", value: { primaryOutcome: "in-hospital mortality" }, sourceIds: [evidenceId] }
    });
    expect(proposeRes.ok(), await proposeRes.text()).toBe(true);
    const proposalId = (await proposeRes.json()).id;
    const confirmRes = await confirmerApi.post(`/api/v1/studies/${studyId}/control-plane/facts`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { action: "confirm", proposalId, rationale: "Initial primary outcome confirmed from published protocol v1." }
    });
    expect(confirmRes.ok(), await confirmRes.text()).toBe(true);

    // Same fact key, new value -- this is confirmProjectFact's real reconfirmation path, the one
    // genuine trigger for dependency invalidation in this codebase.
    const reproposeRes = await api.post(`/api/v1/studies/${studyId}/control-plane/facts`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { action: "propose", key: "reopen_gap_fixture_binding_check", value: { primaryOutcome: "30-day mortality" }, sourceIds: [evidenceId] }
    });
    expect(reproposeRes.ok(), await reproposeRes.text()).toBe(true);
    const reproposalId = (await reproposeRes.json()).id;
    const reconfirmRes = await confirmerApi.post(`/api/v1/studies/${studyId}/control-plane/facts`, {
      headers: { "idempotency-key": randomUUID(), "if-match-version": "1" },
      data: { action: "confirm", proposalId: reproposalId, rationale: "Primary outcome revised to 30-day mortality per amended protocol." }
    });
    expect(reconfirmRes.ok(), await reconfirmRes.text()).toBe(true);

    const bindingAfter = await prisma.approvalBinding.findUniqueOrThrow({ where: { id: approvalBindingId } });
    expect(bindingAfter.status).toBe("INVALIDATED");
    expect(bindingAfter.invalidatedAt).not.toBeNull();
    const invalidation = await prisma.dependencyInvalidation.findFirst({ where: { studyId, targetId: approvalBindingId } });
    expect(invalidation).not.toBeNull();

    await api.dispose();
    await confirmerApi.dispose();
  });
});
