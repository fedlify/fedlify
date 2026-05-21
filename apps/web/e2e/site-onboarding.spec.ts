import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const password = "E2eSiteAdminPassw0rd!";
const emailDomain = "e2e.fedlify.local";
const slugPrefix = "e2e-site-join";

type SeededScenario = {
  email: string;
  studyId: string;
  studySiteId: string;
  runtimeSiteId: string;
  siteName: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function cleanupE2eRecords() {
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
    await prisma.kitRelease.deleteMany({ where: { studyId: { in: studyIds } } });
    await prisma.agentRun.deleteMany({ where: { studyId: { in: studyIds } } });
  }

  if (orgIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function seedSiteOnboardingScenario(): Promise<SeededScenario> {
  const runId = randomUUID().slice(0, 8);
  const email = `${slugPrefix}-${runId}@${emailDomain}`;
  const siteCode = `site-${runId}`;
  const siteName = `E2E Site ${runId}`;
  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({
    data: {
      name: "E2E Site Admin",
      email,
      passwordHash
    }
  });

  const organization = await prisma.organization.create({
    data: {
      name: `E2E Federation ${runId}`,
      slug: `${slugPrefix}-${runId}`,
      domain: emailDomain,
      createdById: user.id
    }
  });

  await prisma.orgMembership.create({
    data: {
      orgId: organization.id,
      userId: user.id,
      role: "MEMBER"
    }
  });

  const study = await prisma.study.create({
    data: {
      orgId: organization.id,
      title: `E2E Federated Study ${runId}`,
      slug: `e2e-federated-study-${runId}`,
      description: "E2E governed federated learning study.",
      goal: "Validate site onboarding, local readiness, and pipeline review.",
      researchQuestion: "Can a site join the federation without moving raw clinical data?",
      clinicalUseCase: "RISK_PREDICTION",
      population: "Adult inpatient cohort",
      dataModalities: "EHR, Labs",
      primaryOutcome: "Operationally ready connected site",
      riskLevel: "MODERATE",
      intendedUse: "RESEARCH_ONLY",
      governanceStatus: "APPROVED",
      status: "ACTIVE",
      createdById: user.id
    }
  });

  await prisma.studyMember.create({
    data: {
      studyId: study.id,
      userId: user.id,
      role: "SITE_ADMIN"
    }
  });

  await prisma.ethicsApproval.create({
    data: {
      studyId: study.id,
      status: "APPROVED",
      approvalNumber: `E2E-${runId}`,
      approvingBody: "E2E Review Board"
    }
  });

  const site = await prisma.site.create({
    data: {
      studyId: study.id,
      organizationId: organization.id,
      name: siteName,
      code: siteCode,
      institutionName: "E2E Hospital",
      nvflareClientName: `nvflare-${siteCode}`,
      status: "INVITED"
    }
  });

  const studySite = await prisma.studySite.create({
    data: {
      studyId: study.id,
      siteId: site.id,
      organizationId: organization.id,
      code: siteCode,
      name: siteName,
      institutionName: "E2E Hospital",
      participationStatus: "INVITED",
      principalInvestigator: "Dr. E2E Site PI",
      resourceProfile: {
        create: {
          cpuCores: 8,
          gpuCount: 1,
          ramGb: 32,
          storageGb: 500,
          allowByoc: false
        }
      },
      dataProfile: {
        create: {
          modality: "EHR",
          cohortSizeRange: "Not configured",
          datasetDescription: "Pending local data steward confirmation.",
          dataResidency: "site-local"
        }
      },
      readinessChecks: {
        create: {
          status: "PENDING",
          notes: "Initial E2E readiness state."
        }
      }
    }
  });

  await prisma.siteMember.create({
    data: {
      studySiteId: studySite.id,
      userId: user.id,
      role: "SITE_ADMIN",
      invitedById: user.id
    }
  });

  const template =
    (await prisma.pipelineTemplate.findFirst({ where: { active: true, framework: "nvflare" }, orderBy: { name: "asc" } })) ??
    (await prisma.pipelineTemplate.create({
      data: {
        name: "E2E NVFLARE Template",
        templateKey: `e2e-nvflare-template-${runId}`,
        framework: "nvflare",
        description: "E2E fallback template",
        spec: { workflow: "fedavg", dataBoundary: "site-only" }
      }
    }));

  const pipelineProject = await prisma.pipelineProject.create({
    data: {
      studyId: study.id,
      templateId: template.id,
      name: "E2E Site Review Pipeline",
      giteaRepoUrl: "https://gitea.local/fedlify/e2e-pipeline",
      status: "VALIDATED"
    }
  });

  await prisma.pipelineVersion.create({
    data: {
      projectId: pipelineProject.id,
      templateId: template.id,
      version: "v1.0.0",
      gitCommit: `e2e-${runId}`,
      gitBranch: `fedlify/e2e-${runId}`,
      artifactStorageKey: `e2e/${runId}/pipeline`,
      validationStatus: "PASSED",
      approvalStatus: "APPROVED",
      approvedById: user.id,
      approvedAt: new Date(),
      immutable: true,
      ciRuns: {
        create: {
          provider: "e2e",
          workflowId: `e2e-pipeline-${runId}`,
          status: "PASSED",
          summary: "E2E pipeline validation passed.",
          completedAt: new Date()
        }
      }
    }
  });

  const agentRun = await prisma.agentRun.create({
    data: {
      studyId: study.id,
      requestedById: user.id,
      status: "APPROVED",
      inputSummary: "E2E approved source bundle for site review.",
      modelName: "nvflare",
      gitCommit: `e2e-${runId}`,
      validationSummary: "E2E validation passed."
    }
  });

  const storagePrefix = `e2e/${runId}/release/v1`;
  const release = await prisma.kitRelease.create({
    data: {
      studyId: study.id,
      agentRunId: agentRun.id,
      version: "v1",
      status: "APPROVED",
      approvedById: user.id,
      approvedAt: new Date(),
      checksum: sha256(`${study.id}:${agentRun.id}:v1:${storagePrefix}`),
      storagePrefix,
      releaseNotes: "E2E approved pipeline source bundle."
    }
  });

  await prisma.kitArtifact.create({
    data: {
      releaseId: release.id,
      kind: "SOURCE_BUNDLE",
      filename: "e2e-pipeline-source.zip",
      contentType: "application/zip",
      storageKey: `${storagePrefix}/e2e-pipeline-source.zip`,
      checksum: sha256("e2e-pipeline-source"),
      sizeBytes: BigInt(0)
    }
  });

  return {
    email,
    studyId: study.id,
    studySiteId: studySite.id,
    runtimeSiteId: site.id,
    siteName
  };
}

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

test.describe.serial("site onboarding and experiment join", () => {
  let scenario: SeededScenario;

  test.beforeAll(async () => {
    await cleanupE2eRecords();
    scenario = await seedSiteOnboardingScenario();
  });

  test.afterAll(async () => {
    await cleanupE2eRecords();
    await prisma.$disconnect();
  });

  test("site admin joins the experiment from the participant site card", async ({ page }) => {
    await signInWithCredentials(page, scenario.email);
    const studyResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v1/studies/${scenario.studyId}`), {
      timeout: 45_000
    });
    await page.goto(`/studies/${scenario.studyId}?section=sites`);
    const studyResponse = await studyResponsePromise;
    expect(studyResponse.ok(), await studyResponse.text()).toBe(true);

    await expect(page.getByText(scenario.siteName)).toBeVisible();
    await page.locator("button").filter({ hasText: "Open dashboard" }).click();

    await expect(page).toHaveURL(new RegExp(`/sites/${scenario.studySiteId}`));
    await expect(page.getByRole("heading", { name: scenario.siteName })).toBeVisible();
    await expect(page.getByText("Accept participation")).toBeVisible();
    await expect(page.getByText("Join federation")).toBeVisible();

    const joinPackageResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v1/sites/${scenario.studySiteId}/join-package`) && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Download startup kit" }).click();
    const joinPackageResponse = await joinPackageResponsePromise;
    expect(joinPackageResponse.ok(), await joinPackageResponse.text()).toBe(true);
    const joinPackagePayload = (await joinPackageResponse.json()) as { enrollmentToken?: string };
    const token = joinPackagePayload.enrollmentToken ?? "";

    await expect(page.getByText("One-time enrollment token")).toBeVisible();
    await expect(page.getByText(token)).toBeVisible();
    await expect(page.getByText("fedlify-site-startup-kit")).toBeVisible();
    expect(token, "one-time enrollment token should be returned exactly once after package generation").toMatch(/^[A-Za-z0-9_-]{32,}$/);

    await expect
      .poll(async () => prisma.siteJoinPackage.count({ where: { studySiteId: scenario.studySiteId, status: "ACTIVE" } }))
      .toBe(1);

    await page.getByPlaceholder("e.g. 1k-5k records").fill("100-500 records");
    await page.getByPlaceholder("Cohort-level description only. Do not enter patient-level data.").fill(
      "Adult inpatient encounters prepared in the site-local warehouse."
    );
    await page.getByRole("button", { name: "Save data profile" }).click();

    await expect
      .poll(async () => {
        const profile = await prisma.siteDataProfile.findUnique({ where: { studySiteId: scenario.studySiteId } });
        return profile?.cohortSizeRange;
      })
      .toBe("100-500 records");

    await page.getByRole("button", { name: "Accept policy" }).click();
    await expect
      .poll(async () => {
        const latest = await prisma.siteReadinessCheck.findFirst({
          where: { studySiteId: scenario.studySiteId },
          orderBy: { createdAt: "desc" }
        });
        return latest?.policyAccepted;
      })
      .toBe(true);

    await page.getByLabel("Fedlify heartbeat or NVFLARE client connection verified").check();
    await page.getByLabel("Startup kit installed in the local site environment").check();
    await page.getByLabel("Runtime dependencies verified").check();
    await page.getByLabel("Local policy accepted by authorized site staff").check();
    await page.getByRole("button", { name: "Run readiness check" }).click();

    await expect
      .poll(async () => {
        const latest = await prisma.siteReadinessCheck.findFirst({
          where: { studySiteId: scenario.studySiteId },
          orderBy: { createdAt: "desc" }
        });
        return latest?.status;
      })
      .toBe("PASSED");

    const heartbeat = await page.request.post(`/api/v1/sites/${scenario.runtimeSiteId}/heartbeat`, {
      headers: { "x-site-token": token },
      data: {
        status: "CONNECTED",
        version: "e2e-site-agent",
        metadata: { runner: "playwright" }
      }
    });
    expect(heartbeat.ok(), await heartbeat.text()).toBe(true);

    await page.reload();
    await expect(page.getByText("Connected").first()).toBeVisible();
    await expect(page.getByText("Passed").first()).toBeVisible();

    await expect(page.getByText("E2E Site Review Pipeline")).toBeVisible();
    await expect(page.getByText("Source Bundle")).toBeVisible();
    await page.getByRole("button", { name: "Download approved pipeline bundle" }).last().click();
    await expect(page.getByText(/no download URL is available|Object storage artifact/i)).toBeVisible();
  });
});
