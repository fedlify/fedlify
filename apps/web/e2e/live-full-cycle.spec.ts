import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const live = process.env.LIVE_E2E === "1";
const password = "E2eLivePassw0rd!";
const emailDomain = "live.e2e.fedlify.local";
const slugPrefix = "e2e-live";
const runtimeRoot = path.resolve(process.cwd(), process.env.FEDLIFY_RUNTIME_ROOT ?? ".fedlify-runtime");

type LiveScenario = {
  runId: string;
  email: string;
  studyId: string;
  templateId: string;
  studySiteIds: string[];
  runtimeSiteIds: string[];
  composeProjects: string[];
  repo?: { owner: string; name: string };
  deploymentId?: string;
  tempDirs: string[];
};

let adapterProcess: ChildProcess | null = null;

async function signInWithCredentials(page: Page, email: string) {
  const csrfResponse = await page.request.get("/api/auth/csrf");
  expect(csrfResponse.ok()).toBe(true);
  const { csrfToken } = await csrfResponse.json();

  const signInResponse = await page.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email,
      password,
      json: "true",
      redirect: "false"
    }
  });
  expect(signInResponse.ok(), await signInResponse.text()).toBe(true);
}

async function commandOk(command: string, args: string[]) {
  await execFileAsync(command, args, { timeout: 120_000 });
}

async function ensureNvflareDockerImage() {
  const image = process.env.NVFLARE_DOCKER_IMAGE ?? "fedlify-nvflare:2.6.2";
  try {
    await commandOk("docker", ["image", "inspect", image]);
    return;
  } catch {
    // Build below.
  }

  const buildDir = await mkdtemp(path.join(os.tmpdir(), "fedlify-nvflare-image-"));
  await writeFile(
    path.join(buildDir, "Dockerfile"),
    [
      "FROM python:3.9-slim",
      "RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates && rm -rf /var/lib/apt/lists/*",
      "RUN python -m pip install --no-cache-dir --upgrade pip && python -m pip install --no-cache-dir nvflare==2.6.2 numpy",
      "WORKDIR /workspace",
      ""
    ].join("\n")
  );
  try {
    await execFileAsync("docker", ["build", "-t", image, buildDir], { timeout: 600_000, maxBuffer: 20 * 1024 * 1024 });
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

async function startFlareAdapter() {
  const baseUrl = process.env.NVFLARE_FLARE_API_BASE_URL ?? "http://localhost:3010";
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    if (response.ok) return;
  } catch {
    // Start below.
  }

  const python = process.env.NVFLARE_PYTHON ?? "/opt/homebrew/opt/python@3.9/bin/python3.9";
  const script = path.resolve(process.cwd(), "../../services/flare-api-adapter/fedlify_flare_api_adapter.py");
  adapterProcess = spawn(python, [script], {
    cwd: path.resolve(process.cwd(), "../.."),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  adapterProcess.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

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
  expect(baseUrl, "GITEA_BASE_URL must be configured for live E2E").toBeTruthy();
  expect(token, "GITEA_TOKEN must be configured for live E2E").toBeTruthy();
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

async function cleanupLiveRecords(runId?: string) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${emailDomain}` } },
    select: { id: true }
  });
  const userIds = users.map((user) => user.id);
  const organizations = await prisma.organization.findMany({
    where: {
      OR: [{ slug: { startsWith: slugPrefix } }, ...(userIds.length > 0 ? [{ createdById: { in: userIds } }] : [])]
    },
    select: { id: true }
  });
  const orgIds = organizations.map((organization) => organization.id);
  const studies = await prisma.study.findMany({
    where: {
      OR: [
        ...(orgIds.length > 0 ? [{ orgId: { in: orgIds } }] : []),
        ...(userIds.length > 0 ? [{ createdById: { in: userIds } }] : [])
      ]
    },
    select: { id: true }
  });
  const studyIds = studies.map((study) => study.id);

  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        ...(orgIds.length > 0 ? [{ orgId: { in: orgIds } }] : []),
        ...(studyIds.length > 0 ? [{ studyId: { in: studyIds } }] : []),
        ...(userIds.length > 0 ? [{ actorUserId: { in: userIds } }] : [])
      ]
    }
  });
  if (studyIds.length > 0) {
    await prisma.nvflareJobEvent.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareJob.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.nvflareDeployment.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.kitRelease.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.agentRun.deleteMany({ where: { studyId: { in: studyIds } } });
  }
  if (orgIds.length > 0) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (runId) await rm(path.join(runtimeRoot, runId), { recursive: true, force: true });
}

async function seedLiveScenario(): Promise<LiveScenario> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const runId = `${slugPrefix}-${suffix}`;
  const email = `${runId}@${emailDomain}`;
  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({
    data: {
      name: "E2E Live Researcher",
      email,
      passwordHash
    }
  });

  const organization = await prisma.organization.create({
    data: {
      name: `E2E Live Federation ${suffix}`,
      slug: runId,
      domain: emailDomain,
      createdById: user.id
    }
  });

  await prisma.orgMembership.create({ data: { orgId: organization.id, userId: user.id, role: "ORG_ADMIN" } });

  const study = await prisma.study.create({
    data: {
      orgId: organization.id,
      title: `E2E Live Study ${suffix}`,
      slug: `e2e-live-study-${suffix}`,
      description: "Live full-cycle runtime smoke test.",
      goal: "Run a complete local NVFLARE pilot path with two synthetic sites.",
      researchQuestion: "Can Fedlify provision, connect, and submit an approved NVFLARE job?",
      clinicalUseCase: "RISK_PREDICTION",
      population: "Synthetic adult inpatient cohort",
      dataModalities: "EHR, Labs",
      primaryOutcome: "Confirmed NVFLARE job submission",
      riskLevel: "MODERATE",
      intendedUse: "RESEARCH_ONLY",
      governanceStatus: "APPROVED",
      status: "ACTIVE",
      createdById: user.id
    }
  });

  await prisma.studyMember.create({ data: { studyId: study.id, userId: user.id, role: "PRINCIPAL_INVESTIGATOR" } });
  await prisma.ethicsApproval.create({
    data: { studyId: study.id, status: "APPROVED", approvalNumber: `LIVE-${suffix}`, approvingBody: "E2E Review Board" }
  });

  const template =
    (await prisma.pipelineTemplate.findFirst({ where: { active: true, framework: "nvflare" }, orderBy: { name: "asc" } })) ??
    (await prisma.pipelineTemplate.create({
      data: {
        name: "NVFLARE Cross-silo FedAvg",
        templateKey: `live-sag-np-${suffix}`,
        framework: "nvflare",
        description: "Live E2E fallback NVFLARE sag_np_metrics template.",
        spec: { template: "sag_np_metrics", dataBoundary: "site-only" }
      }
    }));

  const studySiteIds: string[] = [];
  const runtimeSiteIds: string[] = [];
  for (const index of [1, 2]) {
    const code = `site_${index}_${suffix}`;
    const site = await prisma.site.create({
      data: {
        studyId: study.id,
        organizationId: organization.id,
        name: `Live Site ${index} ${suffix}`,
        code,
        institutionName: `Live Hospital ${index}`,
        nvflareClientName: code,
        status: "INVITED"
      }
    });
    const studySite = await prisma.studySite.create({
      data: {
        studyId: study.id,
        siteId: site.id,
        organizationId: organization.id,
        code,
        name: `Live Site ${index} ${suffix}`,
        institutionName: `Live Hospital ${index}`,
        participationStatus: "INVITED",
        principalInvestigator: `Dr. Live ${index}`,
        resourceProfile: {
          create: { cpuCores: 4, ramGb: 8, storageGb: 100, allowByoc: false }
        },
        dataProfile: {
          create: {
            modality: "EHR",
            cohortSizeRange: "Synthetic template only",
            datasetDescription: "No patient-level data. Runtime smoke test only.",
            dataResidency: "site-local"
          }
        },
        readinessChecks: { create: { status: "PENDING", notes: "Live E2E initial readiness." } }
      }
    });
    await prisma.siteMember.create({ data: { studySiteId: studySite.id, userId: user.id, role: "SITE_ADMIN", invitedById: user.id } });
    studySiteIds.push(studySite.id);
    runtimeSiteIds.push(site.id);
  }

  return { runId, email, studyId: study.id, templateId: template.id, studySiteIds, runtimeSiteIds, composeProjects: [], tempDirs: [] };
}

async function downloadAndExtractKit(input: { url: string; token: string; composeProject: string; scenario: LiveScenario }) {
  const response = await fetch(input.url);
  const body = Buffer.from(await response.arrayBuffer());
  expect(response.ok, body.toString("utf8")).toBe(true);
  const zip = await JSZip.loadAsync(body);
  expect(zip.file("README.md")).toBeTruthy();
  expect(zip.file("docker-compose.yml")).toBeTruthy();
  expect(zip.file("nvflare/startup/fed_client.json")).toBeTruthy();

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
  await execFileAsync("docker", ["compose", "-f", path.join(tempDir, "docker-compose.yml"), "-p", input.composeProject, "up", "-d"], {
    timeout: 120_000,
    env: { ...process.env, NVFLARE_DOCKER_IMAGE: process.env.NVFLARE_DOCKER_IMAGE ?? "fedlify-nvflare:2.6.2" }
  });
}

test.describe.serial("live full cycle", () => {
  test.skip(!live, "Set LIVE_E2E=1 to run the live Gitea/Docker/NVFLARE full-cycle test.");
  test.setTimeout(15 * 60_000);

  let scenario: LiveScenario;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    await cleanupLiveRecords();
    const userResponse = await giteaRequest(request, "/user");
    expect(userResponse.ok(), await userResponse.text()).toBe(true);
    const org = process.env.GITEA_ORG ?? "fedlify-org";
    const orgResponse = await giteaRequest(request, `/orgs/${encodeURIComponent(org)}`);
    expect(orgResponse.ok(), await orgResponse.text()).toBe(true);
    await commandOk("docker", ["info"]);
    await commandOk("docker", ["compose", "version"]);
    await commandOk("nvflare", ["--version"]);
    await startFlareAdapter();
    await ensureNvflareDockerImage();
    scenario = await seedLiveScenario();
    await request.dispose();
  });

  test.afterAll(async ({ playwright }) => {
    for (const composeProject of scenario?.composeProjects ?? []) {
      await execFileAsync("docker", ["compose", "-p", composeProject, "down"], { timeout: 120_000 }).catch(() => undefined);
    }
    if (scenario?.repo) {
      const request = await playwright.request.newContext();
      await giteaRequest(
        request,
        `/repos/${encodeURIComponent(scenario.repo.owner)}/${encodeURIComponent(scenario.repo.name)}`,
        { method: "DELETE" }
      ).catch(() => undefined);
      await request.dispose();
    }
    for (const tempDir of scenario?.tempDirs ?? []) {
      await rm(tempDir, { recursive: true, force: true });
    }
    if (scenario?.studyId) await rm(path.join(runtimeRoot, scenario.studyId), { recursive: true, force: true });
    await cleanupLiveRecords(scenario?.runId);
    if (adapterProcess) adapterProcess.kill();
    await prisma.$disconnect();
  });

  test("researcher generates pipeline, provisions peers, and submits an approved NVFLARE job", async ({ page }) => {
    await signInWithCredentials(page, scenario.email);

    const proposalResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/pipeline-projects`, {
      data: {
        templateId: scenario.templateId,
        name: `Live Pipeline ${scenario.runId}`,
        prompt:
          "Create a real NVFLARE sag_np_metrics smoke-test pipeline for two synthetic sites. Keep all data site-local and use template-only code."
      }
    });
    expect(proposalResponse.ok(), await proposalResponse.text()).toBe(true);
    const proposalPayload = await proposalResponse.json();
    const pipelineVersion = proposalPayload.pipelineVersion;
    const project = proposalPayload.project;
    scenario.repo = { owner: project.giteaOwner, name: project.giteaRepo };

    expect(pipelineVersion.gitCommit).toMatch(/^[a-f0-9]{40}$/i);
    expect(pipelineVersion.jobWorkspacePath).toContain("nvflare-job");
    expect(await readFile(path.join(pipelineVersion.jobWorkspacePath, "meta.conf"), "utf8")).toContain("min_clients = 2");

    const branchResponse = await giteaRequest(
      page.request,
      `/repos/${encodeURIComponent(project.giteaOwner)}/${encodeURIComponent(project.giteaRepo)}/branches/${encodeURIComponent(
        proposalPayload.proposal.branchName
      )}`
    );
    expect(branchResponse.ok(), await branchResponse.text()).toBe(true);
    const branch = await branchResponse.json();
    expect(branch.commit.id ?? branch.commit.sha).toBe(pipelineVersion.gitCommit);

    const contentResponse = await giteaRequest(
      page.request,
      `/repos/${encodeURIComponent(project.giteaOwner)}/${encodeURIComponent(project.giteaRepo)}/contents/nvflare-job/meta.conf?ref=${encodeURIComponent(
        proposalPayload.proposal.branchName
      )}`
    );
    expect(contentResponse.ok(), await contentResponse.text()).toBe(true);
    expect(proposalPayload.proposal.giteaPullRequestNumber).toBeGreaterThan(0);

    const approvalResponse = await page.request.post(`/api/v1/pipeline-versions/${pipelineVersion.id}/approve`, {
      data: { notes: "Live E2E approval for immutable smoke-test commit." }
    });
    expect(approvalResponse.ok(), await approvalResponse.text()).toBe(true);

    const provisionResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/nvflare/deployments`, { data: {} });
    expect(provisionResponse.ok(), await provisionResponse.text()).toBe(true);
    const { deployment } = await provisionResponse.json();
    scenario.deploymentId = deployment.id;
    scenario.composeProjects.push(deployment.composeProject);
    expect(deployment.lastError).toBeFalsy();
    expect(deployment.serverAddress).toMatch(/^localhost:\d+$/);
    expect(await readFile(path.join(deployment.workspacePath, "project.yml"), "utf8")).toContain("api_version: 3");
    expect(await readFile(path.join(deployment.serverStartupPath, "startup", "fed_server.json"), "utf8")).toContain("admin_port");
    expect(await readFile(path.join(deployment.adminStartupPath, "fed_admin.json"), "utf8")).toContain("admin");

    const startResponse = await page.request.post(
      `/api/v1/studies/${scenario.studyId}/nvflare/deployments/${deployment.id}/start`,
      { data: {} }
    );
    expect(startResponse.ok(), await startResponse.text()).toBe(true);

    for (const [index, studySiteId] of scenario.studySiteIds.entries()) {
      const joinResponse = await page.request.post(`/api/v1/sites/${studySiteId}/join-package`, { data: {} });
      expect(joinResponse.ok(), await joinResponse.text()).toBe(true);
      const joinPayload = await joinResponse.json();
      expect(joinPayload.downloadUrl).toBeTruthy();
      expect(joinPayload.enrollmentToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);

      const composeProject = `${scenario.runId}-site-${index + 1}`;
      scenario.composeProjects.push(composeProject);
      await downloadAndExtractKit({
        url: joinPayload.downloadUrl,
        token: joinPayload.enrollmentToken,
        composeProject,
        scenario
      });
    }

    await expect
      .poll(
        async () =>
          prisma.siteHeartbeat.count({
            where: { siteId: { in: scenario.runtimeSiteIds }, status: "CONNECTED" }
          }),
        { timeout: 120_000 }
      )
      .toBe(2);

    for (const studySiteId of scenario.studySiteIds) {
      await prisma.siteReadinessCheck.create({
        data: {
          studySiteId,
          connectivityVerified: true,
          kitInstalled: true,
          dependenciesVerified: true,
          policyAccepted: true,
          status: "PASSED",
          notes: "Live E2E site kit started and heartbeat received."
        }
      });
    }

    const statusResponse = await page.request.get(`/api/v1/studies/${scenario.studyId}/nvflare/status`);
    expect(statusResponse.ok(), await statusResponse.text()).toBe(true);
    const statusPayload = await statusResponse.json();
    expect(JSON.stringify(statusPayload.systemInfo)).toContain("systemInfo");

    const submitResponse = await page.request.post(`/api/v1/studies/${scenario.studyId}/nvflare/jobs`, {
      data: {
        pipelineVersionId: pipelineVersion.id,
        studySiteIds: scenario.studySiteIds,
        commandSummary: "Live E2E submit approved sag_np_metrics pipeline."
      }
    });
    expect(submitResponse.ok(), await submitResponse.text()).toBe(true);
    const submitPayload = await submitResponse.json();
    expect(submitPayload.job.nvflareJobId).toBeTruthy();

    await expect
      .poll(async () => prisma.nvflareJobEvent.count({ where: { jobId: submitPayload.job.id, eventType: "SUBMITTED" } }))
      .toBe(1);
  });
});
