import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentUpdate = vi.fn();
const submit = vi.fn();
const deployment = {
  id: "d1",
  namespace: "study-x",
  hostname: "x.fedlify.com",
  kitGeneration: 1,
  provisionedSites: [{ name: "site-a" }],
  pipelineVersionId: "live-version"
};

vi.mock("@/lib/agent", () => ({ submitStudyPublishWorkflow: (...a: unknown[]) => submit(...a) }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/governance")>()),
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
    pipelineVersion: { create: async () => ({ id: "new-version", gitCommit: "abc123" }), update: async () => ({}) },
    cIValidationRun: { findFirst: async () => null, create: async () => ({ id: "ci1" }), update: async () => ({}) },
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

function publish() {
  const request = new Request("http://x/api", { method: "POST", body: "{}" });
  return POST(request as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) } as never);
}

describe("publish keeps the live version pointer until the workflow succeeds", () => {
  beforeEach(() => {
    deploymentUpdate.mockReset();
    submit.mockReset();
  });

  it("does not move the pointer when a publish starts", async () => {
    submit.mockResolvedValue({ workflowId: "w1" });
    const response = await publish();
    expect(response?.status).toBe(202);
    expect(deploymentUpdate).toHaveBeenCalled();
    for (const [call] of deploymentUpdate.mock.calls) expect(call.data).not.toHaveProperty("pipelineVersionId");
  });

  it("does not move the pointer when the workflow cannot be submitted", async () => {
    submit.mockRejectedValue(new Error("argo down"));
    const response = await publish();
    expect(response?.status).toBe(503);
    for (const [call] of deploymentUpdate.mock.calls) expect(call.data).not.toHaveProperty("pipelineVersionId");
  });
});
