import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
const execFileAsync = promisify(execFile);
const enabled = process.env.LIVE_PROBE_LIFECYCLE_E2E === "1";
const profile = (process.env.BLIND_PROBE_PROFILE ?? "hosted") as "hosted" | "local";
const executionMode = "LIVE_E2E_AUTHORITATIVE_INTAKE" as const;
const password = "ProbeLifecyclePassw0rd!";
const emailDomain = "probe.lifecycle.fedlify.local";

type Probe = {
  probeId: string;
  actor: string;
  studyContext: string;
  prompt: string;
  fixtureFile: string;
  fixtureContent: string;
  fixtureHash: string;
};

async function loadBlindProbes(): Promise<Probe[]> {
  const suite = path.resolve(process.cwd(), "../../../probs");
  const script = [
    "import csv,hashlib,json,pathlib,sys",
    "root=pathlib.Path(sys.argv[1])",
    "rows=list(csv.DictReader((root/'Fedlify_Probe_Suite_144.csv').open(encoding='utf-8-sig',newline='')))",
    "out=[]",
    "for r in rows:",
    " p=root/r['Fixture_File']; b=p.read_bytes()",
    " out.append({'probeId':r['Probe_ID'],'actor':r['Actor'],'studyContext':r['Study_Context'],'prompt':r['User_Prompt'],'fixtureFile':r['Fixture_File'],'fixtureContent':b.decode('utf-8',errors='replace'),'fixtureHash':hashlib.sha256(b).hexdigest()})",
    "print(json.dumps(out))"
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", script, suite], { maxBuffer: 25 * 1024 * 1024 });
  const probes = JSON.parse(stdout) as Probe[];
  expect(probes).toHaveLength(144);
  return probes;
}

async function signIn(context: APIRequestContext, email: string) {
  const csrf = await context.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await context.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, json: "true", redirect: "false" }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

function limitedActor(actor: string): boolean {
  return /former reviewer|unauthorized|external attacker|revoked/i.test(actor);
}

function scannerFlags(probe: Probe): boolean {
  return /(patientunitstayid|patienthealthsystemstayid|uniquepid|medical record|\bmrn\b|api[_ -]?key|password|bearer token|secret key|-----begin (rsa |openssh )?private key-----)/i
    .test(`${probe.prompt}\n${probe.fixtureContent}`);
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${emailDomain}` } }, select: { id: true } });
  const userIds = users.map(({ id }) => id);
  const organizations = await prisma.organization.findMany({ where: { createdById: { in: userIds } }, select: { id: true } });
  const orgIds = organizations.map(({ id }) => id);
  const studies = await prisma.study.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
  const studyIds = studies.map(({ id }) => id);
  if (studyIds.length) await prisma.auditEvent.deleteMany({ where: { studyId: { in: studyIds } } });
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.describe.serial("authoritative blind probe intake", () => {
  test.skip(!enabled, "Set LIVE_PROBE_LIFECYCLE_E2E=1 to run the authoritative benchmark.");
  test.setTimeout(40 * 60_000);

  let ownerEmail: string;
  let limitedEmail: string;
  let ownerId: string;
  let organizationId: string;

  test.beforeAll(async () => {
    await cleanup();
    const passwordHash = await argon2.hash(password);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const owner = await prisma.user.create({ data: { name: "Probe Owner", email: `owner-${suffix}@${emailDomain}`, passwordHash } });
    const limited = await prisma.user.create({ data: { name: "Probe Limited Actor", email: `limited-${suffix}@${emailDomain}`, passwordHash } });
    const organization = await prisma.organization.create({ data: { name: `Probe ${suffix}`, slug: `probe-${suffix}`, domain: emailDomain, createdById: owner.id } });
    await prisma.orgMembership.create({ data: { orgId: organization.id, userId: owner.id, role: "ORG_ADMIN" } });
    ownerEmail = owner.email!;
    limitedEmail = limited.email!;
    ownerId = owner.id;
    organizationId = organization.id;
  });

  test.afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test("submits all fixtures through one production intake endpoint", async ({ playwright }) => {
    const probes = await loadBlindProbes();
    const owner = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    const limited = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000" });
    await signIn(owner, ownerEmail);
    await signIn(limited, limitedEmail);
    const observations: Array<Record<string, unknown>> = [];

    for (const probe of probes) {
      const study = await prisma.study.create({
        data: {
          orgId: organizationId,
          title: `Authoritative probe ${probe.probeId}`,
          slug: `authoritative-${probe.probeId.toLowerCase()}-${randomUUID().slice(0, 8)}`,
          description: probe.studyContext,
          goal: "Blind authoritative probe execution.",
          governanceStatus: "APPROVED",
          status: "ACTIVE",
          createdById: ownerId,
          members: { create: { userId: ownerId, role: "PRINCIPAL_INVESTIGATOR" } }
        }
      });
      const context = limitedActor(probe.actor) ? limited : owner;
      const response = await context.post(`/api/v1/studies/${study.id}/intake`, {
        headers: { "idempotency-key": `${probe.probeId.toLowerCase()}-${randomUUID()}`, "if-match-version": "1" },
        data: {
          requestText: probe.prompt,
          studyContext: probe.studyContext,
          profile,
          attachments: [{
            name: path.basename(probe.fixtureFile),
            contentType: "application/octet-stream",
            contentHash: probe.fixtureHash,
            content: probe.fixtureContent,
            sourceLocator: `fixture://${probe.fixtureHash}`,
            sourceVersion: "fedlify-probe-suite-1.0"
          }]
        }
      });
      const body = await response.json().catch(() => ({})) as Record<string, any>;
      if (response.status() === 403) {
        observations.push({
          probeId: probe.probeId, executionMode, disposition: "POLICY_STOP",
          blockingLayer: "Policy engine / work-item contract", stopCondition: "1",
          stateTransition: "Request received -> Authority and contract check -> STOP/REJECT",
          prohibitedPropagation: [], evidence: { status: response.status(), body }
        });
        continue;
      }
      if (response.status() !== 201) {
        observations.push({
          probeId: probe.probeId, executionMode, infrastructureFailure: true,
          disposition: "", blockingLayer: "", stopCondition: "", stateTransition: "",
          prohibitedPropagation: [], evidence: { status: response.status(), body }
        });
        continue;
      }

      const persisted = await prisma.decisionRecord.findUnique({ where: { id: String(body.requestId) } });
      const artifacts = await prisma.artifactRevision.count({ where: { studyId: study.id } });
      const exports = await prisma.exportManifest.count({ where: { studyId: study.id } });
      const prohibitedPropagation: string[] = [];
      if (scannerFlags(probe) && body.modelConsulted) prohibitedPropagation.push("HOSTED_OR_LOCAL_MODEL");
      if (scannerFlags(probe) && artifacts) prohibitedPropagation.push("ARTIFACT_REVISION");
      if (scannerFlags(probe) && exports) prohibitedPropagation.push("SIGNED_EXPORT_MANIFEST");
      observations.push({
        probeId: probe.probeId,
        executionMode,
        disposition: body.disposition,
        blockingLayer: body.authoritativeLayer,
        stopCondition: body.stoppingCondition,
        stateTransition: body.stateTransition,
        prohibitedPropagation,
        evidence: {
          status: response.status(), requestId: body.requestId, decisionHash: persisted?.decisionHash,
          policyVersion: body.policyVersion, requirements: body.requirements,
          selectedContractId: body.selectedContractId, workItemId: body.workItemId,
          modelConsulted: body.modelConsulted, execution: body.execution
        }
      });
    }

    const output = path.resolve(process.cwd(), process.env.LIVE_PROBE_OBSERVATIONS ?? "../../probe-results/live-e2e-authoritative/observations.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({
      schemaVersion: "2.0", executionMode,
      coverage: "SINGLE_AUTHENTICATED_AUTHORITATIVE_INTAKE_WITH_PERSISTED_DECISION",
      routingDisclosure: "The executor loads no oracle outcome fields. Platform policy, not the model or harness, selects the authoritative layer.",
      oracleFieldsLoaded: false,
      coordinatorProfile: profile,
      observations
    }, null, 2));
    expect(observations).toHaveLength(144);
    expect(new Set(observations.map(({ probeId }) => probeId)).size).toBe(144);
    await owner.dispose();
    await limited.dispose();
  });
});
