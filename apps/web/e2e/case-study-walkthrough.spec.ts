import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { activationGate } from "../src/lib/governance";

/**
 * Produces the real Task 1/2 numbers for the six-hospital case study (Main.tex) and real
 * platform screenshots for the case-study figure, from one live run against the deployed
 * platform. Not a correctness test: it records what actually happened for the manuscript.
 *
 * Run with: CASE_STUDY_WALKTHROUGH=1 pnpm --filter @fedlify/web exec playwright test \
 *   e2e/case-study-walkthrough.spec.ts --headed=false
 */

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = parts.join("=").replace(/^"|"$/g, "");
  }
}
loadEnvFile(path.resolve(process.cwd(), "../../.env"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

const prisma = new PrismaClient();
const enabled = process.env.CASE_STUDY_WALKTHROUGH === "1";
const password = "CaseStudyWalkthroughPassw0rd!";
const emailDomain = "case-study.fedlify.local";
const shotDir = path.resolve(process.cwd(), process.env.CASE_STUDY_SHOT_DIR ?? "../../paper/v3/Journal_2026_Omid_Method/case-study-shots");
const dataDir = path.resolve(process.cwd(), process.env.CASE_STUDY_DATA_DIR ?? "../../paper/v3/Journal_2026_Omid_Method/case-study-data");

const HOSPITALS = [
  { code: "A", hospitalId: 420 },
  { code: "B", hospitalId: 243 },
  { code: "C", hospitalId: 73 },
  { code: "D", hospitalId: 188 },
  { code: "E", hospitalId: 122 },
  { code: "F", hospitalId: 252, role: "external_validation" as const }
];

async function signIn(page: Page, email: string) {
  const csrf = await page.request.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await page.request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", redirect: "false" }
  });
  expect(response.ok(), await response.text()).toBe(true);
  // The credentials callback sets a cookie on the API context; carry it into the browser page too.
  await page.goto("/dashboard");
}

async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}) {
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: options.fullPage ?? false });
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${emailDomain}` } }, select: { id: true } });
  const userIds = users.map(({ id }) => id);
  const organizations = await prisma.organization.findMany({ where: { createdById: { in: userIds } }, select: { id: true } });
  const orgIds = organizations.map(({ id }) => id);
  const studies = await prisma.study.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
  const studyIds = studies.map(({ id }) => id);
  if (studyIds.length) {
    await prisma.decisionRecord.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.workItem.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.skillContract.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.quarantineRecord.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.describe.serial("six-hospital case study walkthrough", () => {
  test.skip(!enabled, "Set CASE_STUDY_WALKTHROUGH=1 to run the live case-study walkthrough.");
  test.setTimeout(20 * 60_000);

  let ownerEmail: string;
  let ownerId: string;
  let organizationId: string;
  let studyId: string;
  const results: Record<string, unknown> = {};

  test.beforeAll(async () => {
    await cleanup();
    const passwordHash = await argon2.hash(password);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const owner = await prisma.user.create({ data: { name: "Principal Investigator", email: `pi-${suffix}@${emailDomain}`, passwordHash } });
    const organization = await prisma.organization.create({
      data: { name: `ICU Heart Failure Consortium ${suffix}`, slug: `icu-hf-${suffix}`, domain: emailDomain, createdById: owner.id }
    });
    await prisma.orgMembership.create({ data: { orgId: organization.id, userId: owner.id, role: "ORG_ADMIN" } });
    ownerEmail = owner.email!;
    ownerId = owner.id;
    organizationId = organization.id;
  });

  test.afterAll(async () => {
    await mkdir(dataDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dataDir, "results.json"), JSON.stringify(results, null, 2));
    await cleanup();
    await prisma.$disconnect();
  });

  test("Task 1: study objective, intake, and gap resolution", async ({ page }) => {
    await signIn(page, ownerEmail);

    const create = await page.request.post("/api/v1/studies", {
      data: {
        orgId: organizationId,
        title: "ICU Heart Failure Mortality: Six-Hospital Federated Study",
        description: "Develop and externally validate federated models for in-hospital mortality among ICU patients with heart failure. Sites A-E form the training federation; Site F is reserved for external validation. Raw patient data must stay at each site. Compare five approved NVFLARE jobs under a common cohort and preprocessing plan.",
        goal: "Predict in-ICU mortality for heart failure patients across six eICU-derived hospital sites without moving raw clinical data.",
        researchQuestion: "Can a governed federated workflow produce a reproducible, externally validated mortality model across six hospitals with materially different case mix?",
        clinicalUseCase: "RISK_PREDICTION",
        studyDesign: "Retrospective six-site federated study training a governed mortality-risk model for ICU heart failure admissions using site-local structured data only. Five hospitals (2,186-3,600 stays each) form the training federation; a sixth (1,930 stays) is held out for external validation.",
        dataModalities: "EHR, Labs, Vitals",
        primaryOutcome: "In-hospital mortality",
        primaryEndpointDetails: "All-cause in-hospital mortality during the indexed ICU stay, evaluated with held-out external validation on Site F.",
        dataHandlingPlan: "All raw EHR, labs, and vitals remain site-local. Only approved code, aggregate metrics, manifests, and runtime logs leave the site environment.",
        riskLevel: "MODERATE",
        intendedUse: "RESEARCH_ONLY"
        // Deliberately omitted at intake, matching the manuscript's Task 1 narrative:
        // population (cohort definition), eligibilityCriteria (inclusion/exclusion criteria),
        // and analysisPlan (the absent analysis plan). Sites/ethics are also unresolved at this
        // point -- Task 2 covers site readiness separately.
      }
    });
    expect(create.ok(), await create.text()).toBe(true);
    const { study } = await create.json();
    studyId = study.id;
    // POST /api/v1/studies already creates a PRINCIPAL_INVESTIGATOR StudyMember for the creator.

    // Screenshot 1: study dashboard right after creation.
    await page.goto(`/studies/${studyId}`);
    await page.waitForLoadState("networkidle");
    await shot(page, "01-study-dashboard");

    // Screenshot 2a: the real objective form (protocol section), open items still empty.
    await page.goto(`/studies/${studyId}?section=protocol`);
    await page.waitForLoadState("networkidle");
    await shot(page, "02a-objective-form");

    // Task 1, part A: what the platform's real activation gate (governance.ts) reports as
    // unresolved for this study right now -- the same code three production routes already
    // call, invoked here against the real persisted record rather than reimplemented.
    const afterCreate = await prisma.study.findUniqueOrThrow({
      where: { id: studyId },
      include: { ethics: { orderBy: { createdAt: "desc" }, take: 1 }, studySites: true }
    });
    const raisedGate = activationGate(afterCreate);
    const raisedRequirements = raisedGate.missing;

    // The participator sites answer the open protocol items: cohort definition
    // (population), inclusion/exclusion criteria (eligibilityCriteria), and the analysis plan.
    const resolveDetails = await page.request.patch(`/api/v1/studies/${studyId}`, {
      data: {
        action: "updateDetails",
        population: "Adult ICU patients (16-90) admitted with acute or chronic heart failure",
        eligibilityCriteria: "Adults 16-90 with a documented acute or chronic heart failure diagnosis (ICD-9/ICD-10). For patients with multiple ICU admissions, only the final eligible admission is included. Exclude records with missing outcome, ICU stay under four hours, or prior heart transplantation or durable ventricular assist device support.",
        analysisPlan: "Cross-silo NVFLARE workflow comparing FedAvg, FedProx, differentially private SGD, federated logistic regression, and histogram-based federated XGBoost, all trained on identical preprocessing across the same five sites and evaluated on the same held-out sixth site."
      }
    });
    expect(resolveDetails.ok(), await resolveDetails.text()).toBe(true);

    const afterResolution = await prisma.study.findUniqueOrThrow({
      where: { id: studyId },
      include: { ethics: { orderBy: { createdAt: "desc" }, take: 1 }, studySites: true }
    });
    const remainingGate = activationGate(afterResolution);
    const confirmedRequirements = raisedRequirements.filter((item) => !remainingGate.missing.includes(item));

    results.task1_requirements = {
      raised: raisedRequirements,
      raisedCount: raisedRequirements.length,
      confirmed: confirmedRequirements,
      confirmedCount: confirmedRequirements.length,
      stillOpenAfterTask1: remainingGate.missing,
      stillOpenAfterTask1Count: remainingGate.missing.length
    };

    // Task 1, part B: submit the (now more complete) objective through the real, deployed
    // AuthoritativeIntake endpoint -- the same production code path the 144-probe suite
    // exercises, no oracle fields loaded -- to record the platform's live routing behavior.
    const idempotencyKey = `case-study-intake-${randomUUID()}`;
    const intakeResponse = await page.request.post(`/api/v1/studies/${studyId}/intake`, {
      headers: { "idempotency-key": idempotencyKey, "if-match-version": "1" },
      data: {
        requestText: "Structure this approved objective into the Fedlify study specification and show anything still missing.",
        studyContext: "Six-site eICU-derived heart-failure mortality configuration; Sites A-E train and Site F is held out for external validation.",
        profile: "hosted"
      }
    });
    const intakeBody = await intakeResponse.json().catch(() => ({}));
    results.task1_intake = { status: intakeResponse.status(), body: intakeBody };

    await mkdir(dataDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dataDir, "intake-response.json"), JSON.stringify(intakeBody, null, 2));

    // Task 1, part C: the requirements chat window -- the guided, question-by-question
    // counterpart to the static protocol form. Real UI interaction, real persistence,
    // answered against the actual six-hospital study, not placeholder text.
    await page.goto(`/studies/${studyId}?section=protocol`);
    await page.waitForLoadState("networkidle");
    await page.getByText("Requirements checklist", { exact: false }).first().click();
    await page.waitForTimeout(400);
    await shot(page, "06-requirements-chat-question");

    const requirementAnswers: Array<[string, string]> = [
      ["R01", "Predict in-hospital mortality for ICU patients with heart failure across six eICU-derived hospitals. Raw EHR data cannot leave each site under each institution's data use agreement, so a federated workflow is required instead of centralizing patient records."],
      ["R02", "Five hospitals (2,186-3,600 ICU stays each) form the training federation; a sixth (1,930 stays) is held out for external validation. Each site's data volume, infrastructure, and readiness were assessed during onboarding before any training job was approved."],
      ["R03", "The principal investigator owns study design and approvals; each site names a local PI and readiness reviewer; a named engineer owns pipeline deployment and execution, kept separate from planning."],
      ["R04", "Ethics approval or exemption is recorded per site before activation; the eICU Collaborative Research Database's existing data use agreement governs the underlying data, and no raw patient data crosses institutional boundaries."],
      ["R05", "The study PI approves the protocol and specification; each site retains ownership of its local data; a named engineer, not the assistant, controls deployment, execution, and release of any artifact."],
      ["R06", "Risk level is set to moderate given structured EHR data and no direct patient contact; human review gates apply to specification approval, site readiness, and release, matching that risk level."],
      ["R07", "Sites join through a governed onboarding flow with connectivity, dependency, and policy checks; a protocol amendment reopens dependent approvals and marks affected configurations stale."],
      ["R08", "All six sites use the same eICU-derived schema for demographics, vitals, labs, and the in-hospital mortality outcome, with a shared feature dictionary agreed before training."]
    ];
    for (const [, answer] of requirementAnswers) {
      const textarea = page.locator(".fedlify-requirements-active textarea");
      await expect(textarea).toBeVisible({ timeout: 10000 });
      await textarea.fill(answer);
      await page.getByRole("button", { name: /confirm answer/i }).click();
      await page.waitForTimeout(400);
    }
    await shot(page, "07-requirements-chat-progress");
    results.task1_requirements_chat = { answeredThroughUi: requirementAnswers.map(([id]) => id) };
  });

  test("Task 2: site onboarding and readiness gates, one site deliberately blocked", async ({ page, playwright }) => {
    // Each Playwright test gets its own fresh, unauthenticated page -- Task 1's sign-in does
    // not carry over. Without this, the screenshots below silently render the sign-in page.
    await signIn(page, ownerEmail);
    const passwordHash = await argon2.hash(password);
    const attestationsRecorded: string[] = [];
    const blockedBeforeResolution: string[] = [];
    const studySiteIds: string[] = [];

    for (const [index, hospital] of HOSPITALS.entries()) {
      const siteUser = await prisma.user.create({
        data: { name: `Site ${hospital.code} Readiness Reviewer`, email: `site${hospital.code.toLowerCase()}-${randomUUID().slice(0, 8)}@${emailDomain}`, passwordHash }
      });
      const siteOrg = await prisma.organization.create({
        data: { name: `eICU Hospital ${hospital.code}`, slug: `eicu-hospital-${hospital.code.toLowerCase()}-${randomUUID().slice(0, 6)}`, domain: emailDomain, createdById: siteUser.id }
      });
      await prisma.orgMembership.create({ data: { orgId: siteOrg.id, userId: siteUser.id, role: "ORG_ADMIN" } });
      const code = `hospital_${hospital.hospitalId}`;
      const site = await prisma.site.create({
        data: { studyId, organizationId: siteOrg.id, name: `eICU Hospital ${hospital.code}`, code, institutionName: `eICU Hospital ${hospital.code}`, nvflareClientName: code, status: "INVITED" }
      });
      const studySite = await prisma.studySite.create({
        data: {
          studyId, siteId: site.id, organizationId: siteOrg.id, code, name: `eICU Hospital ${hospital.code}`,
          institutionName: `eICU Hospital ${hospital.code}`, participationStatus: "INVITED",
          principalInvestigator: `Site ${hospital.code} PI`,
          resourceProfile: { create: { cpuCores: 4, ramGb: 8, storageGb: 100, allowByoc: false } },
          dataProfile: { create: { modality: "EHR", cohortSizeRange: "2,186-3,600 stays", datasetDescription: "eICU-derived heart-failure ICU stays, site-local only.", dataResidency: "site-local" } },
          readinessChecks: { create: { status: "PENDING", notes: "Awaiting governance document." } }
        }
      });
      await prisma.siteMember.create({ data: { studySiteId: studySite.id, userId: siteUser.id, role: "SITE_ADMIN", invitedById: ownerId } });
      studySiteIds.push(studySite.id);

      const siteContext = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
      const csrf = await siteContext.get("/api/auth/csrf");
      const { csrfToken } = await csrf.json();
      await siteContext.post("/api/auth/callback/credentials", { form: { csrfToken, email: siteUser.email!, password, json: "true", redirect: "false" } });

      // The last site (E) submits an incomplete readiness attestation first, so there is a
      // real blocked gate to record and photograph, then resolves it -- matching the
      // manuscript's own description of the approval-gate behavior.
      if (index === HOSPITALS.length - 1) {
        const incomplete = await siteContext.patch(`/api/v1/sites/${studySite.id}/governance`, {
          data: { readiness: { connectivityVerified: true, kitInstalled: false, dependenciesVerified: false, policyAccepted: true, notes: "Governance document uploaded; local install still pending." } }
        });
        expect(incomplete.ok(), await incomplete.text()).toBe(true);
        const incompletePayload = await incomplete.json();
        if (incompletePayload.studySite.readinessChecks[0].status !== "PASSED") {
          blockedBeforeResolution.push(hospital.code);
        }
      }

      const governance = await siteContext.patch(`/api/v1/sites/${studySite.id}/governance`, {
        data: { readiness: { connectivityVerified: true, kitInstalled: true, dependenciesVerified: true, policyAccepted: true, notes: `Governance document and readiness attestation for eICU Hospital ${hospital.code}.` } }
      });
      expect(governance.ok(), await governance.text()).toBe(true);
      const governancePayload = await governance.json();
      expect(governancePayload.studySite.readinessChecks[0].status).toBe("PASSED");
      attestationsRecorded.push(hospital.code);
      await siteContext.dispose();
    }

    results.task2 = {
      totalSites: HOSPITALS.length,
      attestationsRecorded: attestationsRecorded.length,
      sitesBlockedBeforeResolution: blockedBeforeResolution.length,
      blockedSiteCodes: blockedBeforeResolution
    };

    // Screenshot 3: confirmed specification.
    await page.goto(`/studies/${studyId}?section=protocol`);
    await page.waitForLoadState("networkidle");
    await shot(page, "03-confirmed-specification");

    // Screenshot 4: site readiness (all sites now passed; DB history still shows the blocked event).
    await page.goto(`/studies/${studyId}?section=sites`);
    await page.waitForLoadState("networkidle");
    await shot(page, "04-site-readiness");

    // Screenshot 5: audit log (approval / artifact history).
    await page.goto(`/studies/${studyId}?section=audit`);
    await page.waitForLoadState("networkidle");
    await shot(page, "05-audit-history");
  });
});
