import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "a".repeat(64);
const B = "b".repeat(64);
const studySiteFind = vi.fn();
const deploymentFind = vi.fn();
const jobCreate = vi.fn();
const submit = vi.fn();
const systemInfo = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/governance", () => ({
  describeUnreadySites: () => [],
  executionGateMessage: () => "gate",
  latestEthicsStatus: () => "APPROVED",
  pipelineExecutionGate: () => ({ allowed: true, missing: [] })
}));
vi.mock("@/lib/nvflare", () => ({ submitNvflareJob: vi.fn() }));
vi.mock("@/lib/pipeline-code", () => ({
  pipelineRunWorkspacePath: vi.fn(),
  prepareNvflareJobWorkspaceForRun: vi.fn(),
  runtimeParametersForSelectedSites: ({ selectedSiteCount }: { selectedSiteCount: number }) => ({ minClients: selectedSiteCount, numRounds: 3 })
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", orgId: "o1", ethics: [] }) },
    pipelineVersion: { findUnique: async () => ({ id: "pv1", version: "v2", gitCommit: "abc", imageDigest: null, approvalStatus: "APPROVED", validationStatus: "PASSED", project: { studyId: "s1" } }) },
    studySite: { findMany: (...a: unknown[]) => studySiteFind(...a) },
    nvflareDeployment: { findFirst: (...a: unknown[]) => deploymentFind(...a) },
    nvflareJob: { create: (...a: unknown[]) => jobCreate(...a), update: async () => ({}) },
    nvflareJobEvent: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      typeof fn === "function" ? fn({ nvflareJob: { update: async () => ({ id: "j1", nvflareJobId: "n1" }) }, nvflareJobEvent: { create: async () => ({}) } }) : fn
  }
}));
vi.mock("@/lib/study-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/study-runtime")>()),
  adapterSystemInfo: (...a: unknown[]) => systemInfo(...a),
  adapterSubmitJob: (...a: unknown[]) => submit(...a)
}));

import { POST } from "@/app/api/v1/studies/[studyId]/nvflare/jobs/route";

const now = () => new Date();
const site = (code: string, metadata: unknown) => ({
  id: `ss-${code}`, siteId: `site-${code}`, code, name: `Hospital ${code}`, readinessChecks: [{ dependenciesVerified: true, policyAccepted: true }],
  site: { nvflareClientName: `site-${code}`, heartbeats: [{ createdAt: now(), metadata }] }
});
const post = () =>
  POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ pipelineVersionId: "pv1" }) }) as never, { params: Promise.resolve({ studyId: "s1" }) }) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  deploymentFind.mockResolvedValue({ id: "d1", serverAddress: "agg:443", runtimeMode: "k8s", adapterUrl: "http://a", pipelineVersionId: "pv1", imageDigest: `harbor.example/fedlify-s-x/study@sha256:${B}`, hostname: "x.fedlify.com" });
  systemInfo.mockResolvedValue({ clients: [{ name: "site-A" }, { name: "site-B" }], server: { status: "x" }, runningJobs: [] });
  jobCreate.mockResolvedValue({ id: "j1" });
  submit.mockResolvedValue({ nvflareJobId: "n1" });
});

describe("POST nvflare/jobs image currency", () => {
  it("refuses with site_image_mismatch, naming the site that still runs the old digest, and never submits", async () => {
    studySiteFind.mockResolvedValue([site("A", { imageDigest: `harbor.example/fedlify-s-x/study@sha256:${B}` }), site("B", { imageDigest: `harbor.example/fedlify-s-x/study@sha256:${A}` })]);
    const response = await post();
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("site_image_mismatch");
    expect(error.sites.map((s: { clientName: string }) => s.clientName)).toEqual(["site-B"]);
    expect(error.sites[0].fix.join(" ")).toContain("fedlify-runner.sh update");
    expect(error.message).toContain("Hospital B");
    expect(error.message).not.toContain("Hospital A");
    expect(error.message).not.toMatch(/aggregator|digest|image|site-B/i);
    expect(jobCreate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses a site that reported no digest at all", async () => {
    studySiteFind.mockResolvedValue([site("A", { imageDigest: `harbor.example/fedlify-s-x/study@sha256:${B}` }), site("B", { container: "running" })]);
    const response = await post();
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("site_image_mismatch");
    expect(error.sites[0]).toMatchObject({ clientName: "site-B", state: "NOT_REPORTED" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts sites on the same sha256 even when their repository path differs", async () => {
    studySiteFind.mockResolvedValue([site("A", { imageDigest: `harbor.example/fedlify-s-x/study@sha256:${B}` }), site("B", { imageDigest: `harbor.example/legacy/study@sha256:${B}` })]);
    const response = await post();
    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
