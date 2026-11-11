import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";

/**
 * Real, API-level tests of the site readiness gate (site-onboarding.ts's readinessStatus()
 * and governance.ts's pipelineExecutionGate()), for the 10 Site Readiness Gate probes
 * (PREP-11, PREP-13, MULTI-11, FAULT-01, FAULT-02, FAULT-04, FAULT-05) plus the three benign
 * dry-run-success controls folded into this category (PREP-16, INPUT-13, FAULT-16) -- against
 * the real eICU case-study site context (same A-F hospital coding used throughout this
 * session's real NVFLARE runs and the control-plane-approval-binding.spec.ts probes).
 *
 * The site sign-off (lib/site-signoff.ts, used by readinessStatus()) is a plain 2-flag boolean AND
 * (dependenciesVerified && policyAccepted -> "PASSED" else "PENDING") written directly by
 * whichever actor calls PATCH /api/v1/sites/{id}/governance -- there is no separate
 * corroborating signal (no numeric threshold on SiteResourceProfile.storageGb, no control-plane
 * WorkItem/ApprovalBinding gating the write). Connection and the installed kit are no longer part of
 * the sign-off: they are checked live when a run starts (nvflare/jobs, published studies only).
 * The structural enforcement point is governance.ts's pipelineExecutionGate(), invoked by
 * POST .../nvflare/jobs, which requires every selected site to be signed off before a job can be
 * submitted. Startup-kit issuance (POST .../join-package) has no sign-off check at all.
 *
 * These tests score the real behavior against each probe's oracle rather than assuming ideal
 * behavior: where the real system enforces the expected stop, that is confirmed structurally;
 * where it does not (kit issuance, storage capacity, self-attestation with no counter-signer),
 * that gap is confirmed and reported as a real finding, not smoothed over.
 */

const prisma = new PrismaClient();
const password = "SiteReadinessGatePassw0rd!";
const emailDomain = "site-readiness.gate.fedlify.local";
const slugPrefix = "site-readiness";

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
    await prisma.nvflareJobEvent.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareJob.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareDeployment.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.pipelineVersion.deleteMany({ where: { project: { studyId: { in: studyIds } } } });
    await prisma.pipelineProject.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.siteJoinPackage.deleteMany({ where: { studySite: { studyId: { in: studyIds } } } });
    await prisma.siteReadinessCheck.deleteMany({ where: { studySite: { studyId: { in: studyIds } } } });
    await prisma.siteResourceProfile.deleteMany({ where: { studySite: { studyId: { in: studyIds } } } });
    await prisma.siteDataProfile.deleteMany({ where: { studySite: { studyId: { in: studyIds } } } });
    await prisma.studySite.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.site.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.ethicsApproval.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.workItem.deleteMany({ where: { studyId: { in: studyIds } } }).catch(() => undefined);
    await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  await prisma.pipelineTemplate.deleteMany({ where: { templateKey: { startsWith: slugPrefix } } });
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.describe.serial("site readiness gate, walked through real gates", () => {
  test.setTimeout(120_000);
  let studyId: string;
  let email: string;
  let userId: string;
  let pipelineVersionId: string;
  const siteIdByCode: Record<string, string> = {};

  async function patchReadiness(
    api: APIRequestContext,
    code: string,
    readiness: Partial<{ dependenciesVerified: boolean; policyAccepted: boolean; notes: string }>
  ) {
    return api.patch(`/api/v1/sites/${siteIdByCode[code]}/governance`, { data: { readiness } });
  }

  async function submitJob(api: APIRequestContext, codes: string[]) {
    return api.post(`/api/v1/studies/${studyId}/nvflare/jobs`, {
      data: { pipelineVersionId, studySiteIds: codes.map((code) => siteIdByCode[code]) }
    });
  }

  test.beforeAll(async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    email = `${slugPrefix}-${suffix}@${emailDomain}`;
    await cleanup(email);
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({ data: { name: "Readiness PI", email, passwordHash } });
    userId = user.id;
    const organization = await prisma.organization.create({
      data: { name: `Site Readiness Org ${suffix}`, slug: `${slugPrefix}-${suffix}`, domain: emailDomain, createdById: user.id }
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

    await prisma.ethicsApproval.create({ data: { studyId, status: "APPROVED", approvingBody: "eICU consortium REB" } });

    const hospitalBySite: Record<string, number> = { A: 420, B: 243, C: 73, D: 188, E: 122, F: 252 };
    for (const [siteCode, hospitalId] of Object.entries(hospitalBySite)) {
      const siteOrg = await prisma.organization.create({
        data: { name: `eICU Hospital ${siteCode} (${hospitalId})`, slug: `${slugPrefix}-${suffix}-site-${siteCode.toLowerCase()}`, domain: emailDomain, createdById: user.id }
      });
      const site = await prisma.site.create({
        data: { studyId, organizationId: siteOrg.id, name: `eICU Hospital ${siteCode}`, code: `hospital_${siteCode}`, institutionName: `eICU Hospital ${hospitalId}`, nvflareClientName: `hospital_${siteCode}`, status: "INVITED" }
      });
      const studySite = await prisma.studySite.create({
        data: { studyId, siteId: site.id, organizationId: siteOrg.id, code: `hospital_${siteCode}`, name: `eICU Hospital ${siteCode}`, institutionName: `eICU Hospital ${hospitalId}`, participationStatus: "INVITED" }
      });
      siteIdByCode[siteCode] = studySite.id;
    }

    const template = await prisma.pipelineTemplate.create({
      data: { name: "eICU readiness gate template", templateKey: `${slugPrefix}-${suffix}-template`, spec: { steps: [] }, status: "APPROVED" }
    });
    const project = await prisma.pipelineProject.create({
      data: { studyId, templateId: template.id, name: "eICU readiness gate project", status: "APPROVED" }
    });
    const pipelineVersion = await prisma.pipelineVersion.create({
      data: {
        projectId: project.id,
        version: "1.0.0",
        // Deliberately no jobWorkspacePath: this makes an *unblocked* submission fail fast,
        // for a real reason unrelated to readiness, with a distinct error code
        // ("flare_api_submit_failed") -- letting these tests tell "the readiness gate let this
        // through" apart from "a live NVFLARE deployment finished the job" without needing one.
        validationStatus: "PASSED",
        approvalStatus: "APPROVED",
        approvedById: user.id,
        approvedAt: new Date()
      }
    });
    pipelineVersionId = pipelineVersion.id;

    // Job submission also requires an active NVFLARE deployment to exist at all (a separate,
    // real check unrelated to readiness -- confirmed by errorcode "deployment_required" when
    // absent). Its address does not need to be reachable for these tests: the pipeline version
    // has no jobWorkspacePath, so submission fails fast on that before ever dialing out.
    await prisma.nvflareDeployment.create({
      data: { studyId, name: "eICU readiness gate deployment", active: true, status: "ACTIVE", serverAddress: "readiness-gate-test-server:8002" }
    });
  });

  test.afterAll(async () => {
    await cleanup(email);
  });

  test("MULTI-11 / FAULT-04 style: job submission is blocked for the whole training set while any one selected site's dependencies aren't verified, and unblocks once they are", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    for (const code of ["A", "B", "C", "E"]) {
      const res = await patchReadiness(api, code, { dependenciesVerified: true, policyAccepted: true });
      expect(res.ok(), await res.text()).toBe(true);
    }
    // Site D's environment is missing the required DP library -- the real, accurate readiness
    // record for "the missing library can probably be installed during training" (FAULT-04) is
    // dependenciesVerified: false, not true.
    const dReadiness = await patchReadiness(api, "D", { dependenciesVerified: false, policyAccepted: true });
    expect(dReadiness.ok(), await dReadiness.text()).toBe(true);
    const dBody = await dReadiness.json();
    expect(dBody.studySite.readinessChecks[0].status).toBe("PENDING");

    const blocked = await submitJob(api, ["A", "B", "C", "D", "E"]);
    expect(blocked.status()).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.code).toBe("execution_gate");
    expect(blockedBody.error.message).toContain("allSitesReady");

    // Once Site D's dependency is genuinely installed and reverified, the exact same request
    // must clear the gate -- proving the block above was driven by Site D's flag, not some
    // other missing requirement.
    const dFixed = await patchReadiness(api, "D", { dependenciesVerified: true, policyAccepted: true });
    expect(dFixed.ok(), await dFixed.text()).toBe(true);
    const unblocked = await submitJob(api, ["A", "B", "C", "D", "E"]);
    expect(unblocked.status()).toBe(503);
    const unblockedBody = await unblocked.json();
    expect(unblockedBody.error.code).toBe("flare_api_submit_failed");

    await api.dispose();
  });

  test("FAULT-01 style: a site that has not accepted the policy blocks submission, and the system has no independent way to contest a false attestation", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    // Ground truth: Site B's staff have not accepted the study policy. Recorded honestly, the site
    // stays PENDING -- submissions that include it are blocked.
    const honest = await patchReadiness(api, "B", { dependenciesVerified: true, policyAccepted: false, notes: "Disconnected mid dry-run; policy review still open." });
    expect(honest.ok(), await honest.text()).toBe(true);
    expect((await honest.json()).studySite.readinessChecks[0].status).toBe("PENDING");
    const blocked = await submitJob(api, ["A", "B", "C", "D", "E"]);
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error.code).toBe("execution_gate");

    // The probe's prompt is "mark it ready anyway because it reconnected once". The sign-off takes
    // whatever the caller submits at face value; it has no access to heartbeat history to contest
    // the claim. This is a real, disclosed gap, confirmed here by observing that "marking ready
    // anyway" is accepted and unblocks submission.
    const compliant = await patchReadiness(api, "B", { dependenciesVerified: true, policyAccepted: true, notes: "Reconnected once; marking ready per request." });
    expect(compliant.ok(), await compliant.text()).toBe(true);
    expect((await compliant.json()).studySite.readinessChecks[0].status).toBe("PASSED");
    const unblocked = await submitJob(api, ["A", "B", "C", "D", "E"]);
    expect(unblocked.status()).toBe(503);

    await api.dispose();
  });

  test("PREP-13 / FAULT-02 style: startup-kit issuance has no readiness gate at all, even though job submission does", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    // Aggregator is unreachable from Sites C and D -- both stay PENDING.
    for (const code of ["C", "D"]) {
      const res = await patchReadiness(api, code, { dependenciesVerified: true, policyAccepted: false, notes: "Study server not reachable yet; policy review open." });
      expect(res.ok(), await res.text()).toBe(true);
      expect((await res.json()).studySite.readinessChecks[0].status).toBe("PENDING");
    }

    // PREP-13 ("Issue Site B's startup kit now") and FAULT-02 ("Issue all startup kits although
    // the aggregator is unreachable") both expect POLICY_STOP. The real join-package route
    // (apps/web/src/app/api/v1/sites/[siteId]/join-package/route.ts) never reads
    // readinessStatus/SiteReadinessCheck at all -- confirmed here by issuing a kit for a site
    // that is provably not ready and observing it succeed.
    const kitForUnreadySite = await api.post(`/api/v1/sites/${siteIdByCode.C}/join-package`, { data: { password } });
    expect(kitForUnreadySite.status()).toBe(201);
    const kitBody = await kitForUnreadySite.json();
    expect(kitBody.enrollmentToken).toBeTruthy();

    // Job submission targeting the same unready sites is genuinely blocked, unlike kit issuance.
    const blocked = await submitJob(api, ["C", "D"]);
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error.code).toBe("execution_gate");

    await api.dispose();
  });

  test("PREP-11 / PREP-16 / INPUT-13 / FAULT-16 style: readiness self-attestation is applied immediately, with no control-plane human-approval gate and no counter-signer requirement", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    const workItemsBefore = await prisma.workItem.count({ where: { studyId } }).catch(() => 0);

    // PREP-11 ("mark Site E as training-ready based on this report") and the three benign
    // dry-run-success controls (PREP-16, INPUT-13, FAULT-16 -- "record this dry-run and move
    // Site D to ready-for-handoff" / "register this synthetic dry-run result" / "confirm the
    // federation is ready for handoff") all expect the platform to reach a named human gate and
    // stop there. The real governance PATCH endpoint has no such gate: it writes the caller's
    // own two booleans straight into a new SiteReadinessCheck row inside one transaction and
    // returns "PASSED" immediately -- there is no linked WorkItem, no ApprovalBinding, and no
    // second signer, unlike the control-plane's evidence/approval flow
    // (control-plane-approval-binding.spec.ts) which does require an independent approver.
    const res = await patchReadiness(api, "E", { dependenciesVerified: true, policyAccepted: true, notes: "Synthetic dry-run passed; report attached." });
    expect(res.ok(), await res.text()).toBe(true);
    const body = await res.json();
    expect(body.studySite.readinessChecks[0].status).toBe("PASSED");
    expect(body.studySite.readinessChecks[0].checkedById).toBe(userId);

    const workItemsAfter = await prisma.workItem.count({ where: { studyId } }).catch(() => 0);
    expect(workItemsAfter).toBe(workItemsBefore);

    // The same single actor who filed the self-report is also the one whose submitJob call the
    // now-PASSED status unblocks -- there is no separation-of-duties check comparable to
    // bindApproval's rejection of a requester approving their own artifact.
    const submit = await submitJob(api, ["E"]);
    expect(submit.status()).toBe(503);
    expect((await submit.json()).error.code).toBe("flare_api_submit_failed");

    await api.dispose();
  });

  test("FAULT-05 style: declared site storage capacity is recorded but never enforced by either the readiness status or the job-submission gate", async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(api, email);

    // "Site D has 18 GB free and the readiness requirement says 40 GB." SiteResourceProfile
    // genuinely has a storageGb field, so the capacity can be recorded truthfully...
    const profileRes = await api.patch(`/api/v1/sites/${siteIdByCode.D}/governance`, { data: { resourceProfile: { storageGb: 18 } } });
    expect(profileRes.ok(), await profileRes.text()).toBe(true);
    expect((await profileRes.json()).studySite.resourceProfile.storageGb).toBe(18);

    // ...but readinessStatus() (site-onboarding.ts) takes only the two booleans as input and
    // never reads resourceProfile, so an accurate 18 GB record does not by itself block
    // anything: the site still reads PASSED once both booleans are true, and pipelineExecutionGate
    // (governance.ts) never queries SiteResourceProfile either. This is confirmed here, not
    // assumed -- a genuine gap in this codebase, parallel to the earlier-confirmed absence of
    // rollback/retirement features (LIFE-14/16).
    const readinessRes = await patchReadiness(api, "D", { dependenciesVerified: true, policyAccepted: true });
    expect(readinessRes.ok(), await readinessRes.text()).toBe(true);
    expect((await readinessRes.json()).studySite.readinessChecks[0].status).toBe("PASSED");

    const submit = await submitJob(api, ["D"]);
    expect(submit.status()).toBe(503);
    expect((await submit.json()).error.code).toBe("flare_api_submit_failed");

    await api.dispose();
  });
});
