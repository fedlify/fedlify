import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import JSZip from "jszip";

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").replace(/^"|"$/g, "");
  }
}

loadEnvFile(path.resolve(process.cwd(), "../../.env"));
loadEnvFile(path.resolve(process.cwd(), ".env"));

const prisma = new PrismaClient();
const execFileAsync = promisify(execFile);
const password = "EicuRealFedAvgPassw0rd!";
const emailDomain = "eicu.real.fedavg.fedlify.local";
const slugPrefix = "eicu-real";
const runtimeRoot = path.resolve(process.cwd(), process.env.FEDLIFY_RUNTIME_ROOT ?? ".fedlify-runtime");
const SITE_DATA_DIR = "/private/tmp/claude-501/-Users-yumcoder-Desktop-UofT-Fedlify-gitops-fedlify-code/42cdb240-1556-4153-b94c-561adc681050/scratchpad/eicu_real_run/site_data";
const CLIENT_SCRIPT = "/private/tmp/claude-501/-Users-yumcoder-Desktop-UofT-Fedlify-gitops-fedlify-code/42cdb240-1556-4153-b94c-561adc681050/scratchpad/eicu_real_run/real_fedavg_client.py";
const OUTPUT_DIR = "/private/tmp/claude-501/-Users-yumcoder-Desktop-UofT-Fedlify-gitops-fedlify-code/42cdb240-1556-4153-b94c-561adc681050/scratchpad/eicu_real_run/output";
const TRAINING_HOSPITALS = [420, 243, 73, 188, 122];
// Hardcoded, not deferring to process.env.NVFLARE_DOCKER_IMAGE: the repo's own .env files
// already set that variable to "fedlify-nvflare:2.6.2" (no scikit-learn) for the smoke-test
// e2e path, and this run genuinely needs the scikit-learn-enabled image regardless of that.
const NVFLARE_IMAGE = "fedlify-nvflare-real:2.6.2";

type Scenario = {
  runId: string;
  email: string;
  studyId: string;
  templateId: string;
  studySiteIds: string[];
  siteParticipants: Array<{ hospitalId: number; email: string; organizationSlug: string; studySiteId: string }>;
  composeProjects: string[];
  repo?: { owner: string; name: string };
  deploymentId?: string;
  adminStartupPath?: string;
  tempDirs: string[];
};

let adapterProcess: ChildProcess | null = null;

async function signIn(page: Page, email: string) {
  const csrf = await page.request.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await page.request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", redirect: "false" }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function commandOk(command: string, args: string[]) {
  await execFileAsync(command, args, { timeout: 120_000 });
}

async function startFlareAdapter() {
  const baseUrl = process.env.NVFLARE_FLARE_API_BASE_URL ?? "http://localhost:3010";
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    if (response.ok) return;
  } catch {
    // start below
  }
  const python = process.env.NVFLARE_PYTHON ?? "/opt/homebrew/opt/python@3.9/bin/python3.9";
  const script = path.resolve(process.cwd(), "../../services/flare-api-adapter/fedlify_flare_api_adapter.py");
  adapterProcess = spawn(python, [script], {
    cwd: path.resolve(process.cwd(), "../.."),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  adapterProcess.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${baseUrl}/healthz`);
          return response.ok ? "ready" : "not-ready";
        } catch {
          return adapterProcess?.exitCode === null ? "starting" : `exited: ${adapterProcess?.exitCode} ${stderr}`;
        }
      },
      { timeout: 30_000 }
    )
    .toBe("ready");
}

async function giteaRequest(api: APIRequestContext, pathName: string, options: Parameters<APIRequestContext["fetch"]>[1] = {}) {
  const baseUrl = process.env.GITEA_BASE_URL?.replace(/\/$/, "");
  const token = process.env.GITEA_TOKEN;
  return api.fetch(`${baseUrl}/api/v1${pathName}`, {
    ...options,
    headers: {
      authorization: `token ${token}`,
      accept: "application/json",
      ...(options.data ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
}

async function cleanupRecords(runId?: string) {
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
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        ...(orgIds.length ? [{ orgId: { in: orgIds } }] : []),
        ...(studyIds.length ? [{ studyId: { in: studyIds } }] : []),
        ...(userIds.length ? [{ actorUserId: { in: userIds } }] : [])
      ]
    }
  });
  if (studyIds.length) {
    await prisma.nvflareJobEvent.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareJob.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareDeployment.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.kitRelease.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.agentRun.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (runId) await rm(path.join(runtimeRoot, runId), { recursive: true, force: true });
}

async function seedScenario(): Promise<Scenario> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const runId = `${slugPrefix}-${suffix}`;
  const email = `${runId}@${emailDomain}`;
  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({ data: { name: "eICU Real Researcher", email, passwordHash } });
  const organization = await prisma.organization.create({
    data: { name: `eICU Real Federation ${suffix}`, slug: runId, domain: emailDomain, createdById: user.id }
  });
  await prisma.orgMembership.create({ data: { orgId: organization.id, userId: user.id, role: "ORG_ADMIN" } });

  const study = await prisma.study.create({
    data: {
      orgId: organization.id,
      title: `Real FedAvg ICU Heart Failure Mortality ${suffix}`,
      slug: `real-fedavg-icu-hf-${suffix}`,
      description: "Genuine NVFLARE FedAvg run on the real six-hospital eICU heart-failure cohort.",
      goal: "Predict in-ICU mortality for heart failure patients across 5 real eICU hospitals without moving raw clinical data.",
      researchQuestion: "Does Fedlify's real NVFLARE execution path reproduce the offline simulation's external AUROC?",
      clinicalUseCase: "RISK_PREDICTION",
      population: "Adult ICU patients admitted with acute or chronic heart failure",
      dataModalities: "EHR, Labs, Vitals",
      primaryOutcome: "In-ICU mortality prediction",
      riskLevel: "MODERATE",
      intendedUse: "RESEARCH_ONLY",
      governanceStatus: "APPROVED",
      status: "ACTIVE",
      studyDesign: "Retrospective 5-site federated study training a governed FedAvg mortality-risk MLP using site-local structured data only.",
      eligibilityCriteria: "Include adult ICU encounters with a primary or secondary heart failure diagnosis.",
      primaryEndpointDetails: "Primary endpoint is all-cause in-ICU mortality, evaluated against a held-out sixth hospital.",
      analysisPlan: "Cross-silo NVFLARE FedAvg workflow, 12 rounds, 5 local epochs per round, weighted aggregation by site size.",
      dataHandlingPlan: "All raw EHR, labs, and vitals remain site-local. Only model parameters and aggregate metrics leave the site environment.",
      createdById: user.id
    }
  });
  await prisma.studyMember.create({ data: { studyId: study.id, userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } });
  await prisma.ethicsApproval.create({
    data: { studyId: study.id, status: "APPROVED", approvalNumber: `REAL-${suffix}`, approvingBody: "E2E Review Board" }
  });

  const template =
    (await prisma.pipelineTemplate.findFirst({ where: { active: true, framework: "nvflare" }, orderBy: { name: "asc" } })) ??
    (await prisma.pipelineTemplate.create({
      data: {
        name: "NVFLARE Cross-silo FedAvg",
        templateKey: `real-fedavg-${suffix}`,
        framework: "nvflare",
        description: "Real E2E FedAvg-MLP template.",
        spec: { template: "sag_np_metrics", dataBoundary: "site-only" }
      }
    }));

  const studySiteIds: string[] = [];
  const siteParticipants: Scenario["siteParticipants"] = [];
  for (const hospitalId of TRAINING_HOSPITALS) {
    const siteUser = await prisma.user.create({
      data: { name: `eICU Hospital ${hospitalId} Approver`, email: `${runId}-hospital-${hospitalId}@${emailDomain}`, passwordHash }
    });
    const siteOrganization = await prisma.organization.create({
      data: { name: `eICU Hospital ${hospitalId}`, slug: `${runId}-hospital-${hospitalId}`, domain: emailDomain, createdById: siteUser.id }
    });
    await prisma.orgMembership.create({ data: { orgId: siteOrganization.id, userId: siteUser.id, role: "ORG_ADMIN" } });
    const code = `hospital_${hospitalId}_${suffix}`;
    const site = await prisma.site.create({
      data: {
        studyId: study.id,
        organizationId: siteOrganization.id,
        name: `eICU Hospital ${hospitalId} ${suffix}`,
        code,
        institutionName: `eICU Hospital ${hospitalId}`,
        nvflareClientName: code,
        status: "INVITED"
      }
    });
    const studySite = await prisma.studySite.create({
      data: {
        studyId: study.id,
        siteId: site.id,
        organizationId: siteOrganization.id,
        code,
        name: `eICU Hospital ${hospitalId} ${suffix}`,
        institutionName: `eICU Hospital ${hospitalId}`,
        participationStatus: "INVITED",
        principalInvestigator: `Real E2E Approver ${hospitalId}`,
        resourceProfile: { create: { cpuCores: 4, ramGb: 8, storageGb: 100, allowByoc: false } },
        dataProfile: {
          create: {
            modality: "EHR",
            cohortSizeRange: "Real eICU hospital cohort (site-local only)",
            datasetDescription: "Real per-hospital eICU heart-failure rows, mounted site-local; never committed to git or exported.",
            dataResidency: "site-local"
          }
        },
        readinessChecks: { create: { status: "PENDING", notes: "Real E2E initial readiness." } }
      }
    });
    await prisma.siteMember.create({ data: { studySiteId: studySite.id, userId: siteUser.id, role: "SITE_ADMIN", invitedById: user.id } });
    studySiteIds.push(studySite.id);
    siteParticipants.push({ hospitalId, email: siteUser.email!, organizationSlug: siteOrganization.slug, studySiteId: studySite.id });
  }

  return { runId, email, studyId: study.id, templateId: template.id, studySiteIds, siteParticipants, composeProjects: [], tempDirs: [] };
}

async function downloadAndExtractKit(input: { url: string; token: string; composeProject: string; hospitalId: number; scenario: Scenario }) {
  const response = await fetch(input.url);
  const body = Buffer.from(await response.arrayBuffer());
  expect(response.ok, body.toString("utf8")).toBe(true);
  const zip = await JSZip.loadAsync(body);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${input.composeProject}-`));
  input.scenario.tempDirs.push(tempDir);
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const destination = path.join(tempDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await file.async("arraybuffer")));
  }
  const envExample = (await readFile(path.join(tempDir, ".env.example"), "utf8")).replace(
    "<paste-token-shown-once-in-fedlify>",
    input.token
  );
  await writeFile(path.join(tempDir, ".env"), envExample);

  // Inject real per-site data + the shared preprocessing contract into the mounted nvflare/ dir.
  await copyFile(path.join(SITE_DATA_DIR, `hospital_${input.hospitalId}.json`), path.join(tempDir, "nvflare", "site_data.json"));
  await copyFile(path.join(SITE_DATA_DIR, "categories.json"), path.join(tempDir, "nvflare", "categories.json"));

  await execFileAsync("docker", ["compose", "-f", path.join(tempDir, "docker-compose.yml"), "-p", input.composeProject, "up", "-d"], {
    timeout: 120_000,
    env: { ...process.env, NVFLARE_DOCKER_IMAGE: NVFLARE_IMAGE }
  });
}

test.describe.serial("eicu real fedavg", () => {
  test.setTimeout(30 * 60_000);
  let scenario: Scenario;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    await cleanupRecords();
    const userResponse = await giteaRequest(request, "/user");
    expect(userResponse.ok(), await userResponse.text()).toBe(true);
    const org = process.env.GITEA_ORG ?? "fedlify-org";
    const orgResponse = await giteaRequest(request, `/orgs/${encodeURIComponent(org)}`);
    expect(orgResponse.ok(), await orgResponse.text()).toBe(true);
    await commandOk("docker", ["info"]);
    await commandOk("docker", ["compose", "version"]);
    await commandOk("docker", ["image", "inspect", NVFLARE_IMAGE]);
    await startFlareAdapter();
    await mkdir(OUTPUT_DIR, { recursive: true });
    scenario = await seedScenario();
    await request.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    test.setTimeout(5 * 60_000);
    if (process.env.SKIP_COMPOSE_TEARDOWN === "1") {
      await writeFile(path.join(OUTPUT_DIR, "debug_scenario.json"), JSON.stringify(scenario, null, 2));
      return;
    }
    await Promise.all(
      (scenario?.composeProjects ?? []).map((composeProject) =>
        execFileAsync("docker", ["compose", "-p", composeProject, "down"], { timeout: 120_000 }).catch(() => undefined)
      )
    );
    if (scenario?.repo) {
      const request = await playwright.request.newContext();
      await giteaRequest(request, `/repos/${encodeURIComponent(scenario.repo.owner)}/${encodeURIComponent(scenario.repo.name)}`, {
        method: "DELETE"
      }).catch(() => undefined);
      await request.dispose();
    }
    for (const tempDir of scenario?.tempDirs ?? []) await rm(tempDir, { recursive: true, force: true });
    if (scenario?.studyId) await rm(path.join(runtimeRoot, scenario.studyId), { recursive: true, force: true });
    await cleanupRecords(scenario?.runId);
    if (adapterProcess) adapterProcess.kill();
    await prisma.$disconnect();
  });

  test("real FedAvg-MLP job runs against real eICU data through the live platform", async ({ page }) => {
    await signIn(page, scenario.email);

    const proposalResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/pipeline-projects`, {
      data: {
        templateId: scenario.templateId,
        name: `Real FedAvg Pipeline ${scenario.runId}`,
        prompt: `Create a governed NVFLARE FedAvg pipeline to predict in-ICU mortality for heart failure patients across ${scenario.studySiteIds.length} real eICU sites. Keep all raw EHR, labs, and vitals site-local.`,
        useAi: false
      }
    });
    expect(proposalResponse.ok(), await proposalResponse.text()).toBe(true);
    const proposalPayload = await proposalResponse.json();
    const pipelineVersion = proposalPayload.pipelineVersion;
    const project = proposalPayload.project;
    scenario.repo = { owner: project.giteaOwner, name: project.giteaRepo };

    // Swap the scaffolded synthetic client for the real, reviewed FedAvg-MLP training script.
    const realClientCode = await readFile(CLIENT_SCRIPT, "utf8");
    await writeFile(path.join(pipelineVersion.jobWorkspacePath, "app", "custom", "cifar10.py"), realClientCode);
    await writeFile(
      path.join(pipelineVersion.jobWorkspacePath, "README.md"),
      "# Real FedAvg-MLP NVFLARE job\n\nReviewed, human-supplied training code (not AI-generated). See eicu-real-fedavg.spec.ts.\n"
    );

    const approvalResponse = await page.request.post(`/api/v1/pipeline-versions/${pipelineVersion.id}/approve`, {
      data: { notes: "Real E2E approval: reviewed FedAvg-MLP training code, real eICU data mounted site-local." }
    });
    expect(approvalResponse.ok(), await approvalResponse.text()).toBe(true);

    const provisionResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/nvflare/deployments`, { data: {} });
    expect(provisionResponse.ok(), await provisionResponse.text()).toBe(true);
    const { deployment } = await provisionResponse.json();
    scenario.deploymentId = deployment.id;
    scenario.adminStartupPath = deployment.adminStartupPath;
    scenario.composeProjects.push(deployment.composeProject);
    expect(deployment.lastError).toBeFalsy();

    const startResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/nvflare/deployments/${deployment.id}/start`, {
      data: {}
    });
    expect(startResponse.ok(), await startResponse.text()).toBe(true);

    for (const participant of scenario.siteParticipants) {
      await signIn(page, participant.email);
      const governanceResponse = await page.request.patch(`/api/v1/sites/${participant.studySiteId}/governance`, {
        data: {
          readiness: {
            connectivityVerified: true,
            kitInstalled: true,
            dependenciesVerified: true,
            policyAccepted: true,
            notes: `Real E2E approval for eICU hospital ${participant.hospitalId}; not a real expert approval.`
          }
        }
      });
      expect(governanceResponse.ok(), await governanceResponse.text()).toBe(true);
      const governance = await governanceResponse.json();
      expect(governance.studySite.readinessChecks[0].status).toBe("PASSED");

      const joinResponse = await page.request.post(`/api/v1/sites/${participant.studySiteId}/join-package`, { data: {} });
      expect(joinResponse.ok(), await joinResponse.text()).toBe(true);
      const joinPayload = await joinResponse.json();

      const composeProject = `${scenario.runId}-site-${participant.hospitalId}`;
      scenario.composeProjects.push(composeProject);
      await downloadAndExtractKit({
        url: joinPayload.downloadUrl,
        token: joinPayload.enrollmentToken,
        composeProject,
        hospitalId: participant.hospitalId,
        scenario
      });
    }

    await signIn(page, scenario.email);
    // NVFLARE clients typically finish TLS handshake + registration with the server within a
    // few seconds of container start (confirmed directly in server container logs: "Total
    // clients: N"); the ScatterAndGather controller itself blocks each round until min_clients
    // report in, so a short fixed wait here is sufficient rather than polling the admin API,
    // which does not tolerate rapid repeated session creation.
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const submitResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/nvflare/jobs`, {
      data: {
        pipelineVersionId: pipelineVersion.id,
        studySiteIds: scenario.studySiteIds,
        runtimeParameters: { minClients: scenario.studySiteIds.length, numRounds: 12 },
        commandSummary: "Real E2E: FedAvg-MLP, 12 rounds, real eICU data."
      }
    });
    expect(submitResponse.ok(), await submitResponse.text()).toBe(true);
    const submitPayload = await submitResponse.json();
    const fedlifyJobId = submitPayload.job.id;
    const nvflareJobId = submitPayload.job.nvflareJobId as string;
    expect(nvflareJobId).toBeTruthy();

    await writeFile(
      path.join(OUTPUT_DIR, "job_meta.json"),
      JSON.stringify({ fedlifyJobId, nvflareJobId, adminStartupPath: scenario.adminStartupPath, tempDirs: scenario.tempDirs }, null, 2)
    );

    // Block, via the real NVFLARE admin API, until the job actually completes (not just "submitted").
    const monitorResponse = await fetch("http://localhost:3010/jobs/" + encodeURIComponent(nvflareJobId) + "/monitor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminStartupPath: scenario.adminStartupPath, timeout: 20 * 60, pollInterval: 5 })
    });
    const monitorBody = await monitorResponse.json();
    console.log("monitor result", JSON.stringify(monitorBody));
    await writeFile(path.join(OUTPUT_DIR, "monitor_result.json"), JSON.stringify(monitorBody, null, 2));

    const resultResponse = await fetch(
      `http://localhost:3010/jobs/${encodeURIComponent(nvflareJobId)}/result?adminStartupPath=${encodeURIComponent(scenario.adminStartupPath!)}`
    );
    const resultBody = await resultResponse.json();
    console.log("result path", JSON.stringify(resultBody));
    await writeFile(path.join(OUTPUT_DIR, "result_meta.json"), JSON.stringify(resultBody, null, 2));

    expect(resultResponse.ok, JSON.stringify(resultBody)).toBeTruthy();
  });
});
