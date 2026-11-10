import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  caps: new Set<string>(),
  ownSites: [] as Array<{ code: string }>,
  jobs: [] as Array<Record<string, unknown>>,
  sites: [] as Array<Record<string, unknown>>,
  running: 0,
  publishing: false
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async (_u: string, _s: string, action: string) => h.caps.has(action),
  assertStudyAccess: async (_u: string, _s: string, action: string) => {
    if (!h.caps.has(action)) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", orgId: "o1", ethics: [{ status: "APPROVED" }] }) },
    pipelineVersion: { findUnique: async () => ({ id: "pv1", approvalStatus: "APPROVED", validationStatus: "PASSED", project: { studyId: "s1" } }) },
    nvflareJob: { findMany: async () => h.jobs, count: async () => h.running },
    cIValidationRun: { findFirst: async () => (h.publishing ? { id: "ci1" } : null) },
    nvflareDeployment: { findFirst: async () => null },
    studySite: {
      findMany: async (args: { where: { participationStatus?: { not: string } } }) => {
        if (args.where.participationStatus) return h.sites.filter((site) => site.participationStatus !== args.where.participationStatus!.not);
        return h.sites.length ? h.sites : h.ownSites;
      }
    }
  }
}));

import { GET, POST } from "@/app/api/v1/studies/[studyId]/nvflare/jobs/route";

const params = { params: Promise.resolve({ studyId: "s1" }) };
const job = (id: string, codes: string[]) => ({
  id,
  selectedSites: codes.map((code) => ({ code, nvflareClientName: `site-${code}` })),
  deployment: { adapterUrl: "http://adapter" },
  siteDigests: [{ site: "A" }],
  metricsSummary: { best: 1 },
  events: [{ id: "e" }],
  logArtifacts: [{ id: "l" }],
  metricsJsonl: "{}",
  metricsChecksum: "x",
  logText: "server log",
  logChecksum: "y",
  logsStorageKey: "k",
  siteLostSites: ["B"],
  runParameters: { numRounds: 3 },
  pipelineVersion: { id: "pv1", version: "v1", project: { giteaRepo: "secret" } }
});

beforeEach(() => {
  h.caps.clear();
  h.ownSites = [];
  h.jobs = [job("j1", ["A", "B"]), job("j2", ["B"]), job("j3", ["A"])];
  h.sites = [];
  h.running = 0;
  h.publishing = false;
});

describe("GET nvflare/jobs scoping", () => {
  it("shows a manager every run, unchanged", async () => {
    h.caps.add("read").add("manage");
    const { jobs } = await ((await GET(new Request("http://x") as never, params)) as Response).json();
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(["j1", "j2", "j3"]);
    expect(jobs[0].events).toHaveLength(1);
    expect(jobs[0].logArtifacts).toHaveLength(1);
  });

  it("keeps the server log from a researcher who is not a study manager", async () => {
    h.caps.add("read").add("runAgent");
    const { jobs } = await ((await GET(new Request("http://x") as never, params)) as Response).json();
    expect(jobs).toHaveLength(3);
    expect(jobs[0].metricsSummary).toEqual({ best: 1 });
    for (const key of ["logText", "logChecksum", "logsStorageKey"]) expect(jobs[0]).not.toHaveProperty(key);
    expect(jobs[0].logArtifacts).toEqual([]);
  });

  it("shows a site operator only runs that include their own site, without other sites, logs or aggregates", async () => {
    h.caps.add("read");
    h.ownSites = [{ code: "A" }];
    const { jobs } = await ((await GET(new Request("http://x") as never, params)) as Response).json();
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(["j1", "j3"]);
    expect(jobs[0].selectedSites).toEqual([{ code: "A", nvflareClientName: "site-A" }]);
    for (const key of ["metricsJsonl", "metricsChecksum", "logText", "logChecksum", "logsStorageKey", "siteLostSites", "runParameters"]) expect(jobs[0]).not.toHaveProperty(key);
    expect(jobs[0].pipelineVersion).toEqual({ id: "pv1", version: "v1" });
    expect(jobs[0]).toMatchObject({ events: [], logArtifacts: [], metricsSummary: null, siteDigests: null, deployment: null });
  });

  it("refuses someone without study access", async () => {
    expect(((await GET(new Request("http://x") as never, params)) as Response).status).toBe(403);
  });
});

describe("POST nvflare/jobs run gate", () => {
  const site = (code: string, participationStatus: string, signedOff: boolean) => ({
    id: `ss-${code}`,
    siteId: `site-${code}`,
    code,
    name: code,
    participationStatus,
    readinessChecks: [{ dependenciesVerified: true, policyAccepted: signedOff }],
    site: { nvflareClientName: `site-${code}`, heartbeats: [] }
  });
  const post = async () =>
    (await ((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ pipelineVersionId: "pv1" }) }) as never, params)) as Response).json()).error;

  it("is not blocked by a disabled site that never signed off", async () => {
    h.caps.add("submitJob");
    h.sites = [site("A", "ACTIVE", true), site("B", "DISABLED", false)];
    expect((await post()).code).toBe("deployment_required");
  });

  it("is still blocked by an enabled site that has not signed off", async () => {
    h.caps.add("submitJob");
    h.sites = [site("A", "ACTIVE", true), site("B", "ACTIVE", false)];
    const error = await post();
    expect(error.code).toBe("execution_gate");
    expect(error.unreadySites.map((s: { code: string }) => s.code)).toEqual(["B"]);
  });

  it("refuses a second run while one is running, with the checklist", async () => {
    h.caps.add("submitJob");
    h.sites = [site("A", "ACTIVE", true)];
    h.running = 1;
    const error = await post();
    expect(error.code).toBe("run_in_progress");
    expect(error.details.items.find((i: { code: string }) => i.code === "run_idle")).toMatchObject({ ok: false });
  });

  it("refuses a run while a publish is going on", async () => {
    h.caps.add("submitJob");
    h.sites = [site("A", "ACTIVE", true)];
    h.publishing = true;
    expect((await post()).code).toBe("publish_in_progress");
  });
});
