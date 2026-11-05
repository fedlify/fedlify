import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentUpdate = vi.fn();
const ensureProject = vi.fn();
const mode = vi.fn();
const txCreate = vi.fn();
const submit = vi.fn();
const deployment = {
  id: "d1",
  namespace: "study-x",
  hostname: "x.fedlify.com",
  kitGeneration: 1,
  provisionedSites: [{ name: "site-a" }],
  pipelineVersionId: "live-version"
};

vi.mock("@/lib/registry-access", () => ({ registryMode: () => mode(), ensureStudyRegistryProject: (...a: unknown[]) => ensureProject(...a) }));
vi.mock("@/lib/agent", () => ({ submitStudyPublishWorkflow: (...a: unknown[]) => submit(...a) }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/governance", () => ({
  ethicsCleared: () => true,
  latestEthicsStatus: () => "APPROVED",
  requirementsGate: () => ({ allowed: true, missing: [] })
}));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {},
  isRuntimeConfigurationError: () => false,
  getGiteaBranch: async () => ({ commit: { id: "abc123" } }),
  ensureGiteaTag: async () => undefined
}));
vi.mock("@/lib/study-runtime", () => ({
  clientKitPrefix: () => "kits/",
  nvflareClientName: () => "site-a",
  studyAdapterUrl: () => "http://adapter",
  studyHostname: () => "x.fedlify.com",
  studyNamespace: () => "study-x",
  studyRuntimeSlug: () => "x"
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    pipelineVersion: { create: async () => { txCreate(); return { id: "new-version", gitCommit: "abc123" }; }, update: async () => ({}) },
    cIValidationRun: { create: async () => ({ id: "ci1" }), update: async () => ({}) },
    nvflareDeployment: { update: (...a: unknown[]) => deploymentUpdate(...a) }
  };
  return {
    prisma: {
      study: {
        findUnique: async () => ({ id: "s1", orgId: "o1", slug: "x", title: "X", ethics: [], studySites: [{ code: "a", nvflareClientName: "site-a", site: { id: "z" } }] })
      },
      pipelineProject: {
        findUnique: async () => ({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", templateId: "t1", templateVersionId: null, versions: [{ id: "live-version" }] })
      },
      requirementResponse: { findMany: async () => [] },
      cIValidationRun: { findFirst: async () => null, update: async () => ({}) },
      nvflareDeployment: { findFirst: async () => deployment, update: (...a: unknown[]) => deploymentUpdate(...a) },
      nvflareJob: { count: async () => 0 },
      pipelineVersion: { findFirst: async () => null, update: async () => ({}) },
      $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]))
    }
  };
});

import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/publish/route";
import { HarborError } from "@/lib/harbor-registry";

function publish() {
  const request = new Request("http://x/api", { method: "POST", body: "{}" });
  return POST(request as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) } as never);
}

describe("publish and the per-study registry project", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    submit.mockResolvedValue({ workflowId: "w1" });
    mode.mockReturnValue("per-study");
    ensureProject.mockResolvedValue({ name: "fedlify-s-x", created: true });
  });

  it("creates or confirms the project first and hands it to the workflow", async () => {
    const response = await publish();
    expect(response?.status).toBe(202);
    expect(ensureProject).toHaveBeenCalledWith(expect.objectContaining({ studyId: "s1", runtimeSlug: "x" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ registryProject: "fedlify-s-x" }));
    expect(ensureProject.mock.invocationCallOrder[0]!).toBeLessThan(submit.mock.invocationCallOrder[0]!);
  });

  it.each([
    [new HarborError("exists, not ours", "conflict", 409), 409, "registry_project_conflict"],
    [new HarborError("Harbor is unreachable", "unavailable"), 502, "registry_unavailable"],
    [new HarborError("not configured", "not_configured"), 503, "registry_not_configured"]
  ])("stops before recording a version or submitting when the project cannot be ensured (%#)", async (error, status, code) => {
    ensureProject.mockRejectedValue(error);
    const response = await publish();
    expect(response?.status).toBe(status);
    expect((await response!.json()).error.code).toBe(code);
    expect(submit).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
  });

  it("legacy mode never touches Harbor and passes no project, so the workflow keeps fedlify-studies", async () => {
    mode.mockReturnValue("legacy");
    const response = await publish();
    expect(response?.status).toBe(202);
    expect(ensureProject).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]![0].registryProject).toBeNull();
  });
});
