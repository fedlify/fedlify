import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ giteaOwner: "o" as string | null, txBusy: false, created: 0 }));

vi.mock("@/lib/agent", () => ({ submitStudyPublishWorkflow: async () => ({ workflowId: "w1" }) }));
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
  const deployment = { id: "d1", namespace: "study-x", hostname: "x.fedlify.com", kitGeneration: 1, provisionedSites: [{ name: "site-a" }], pipelineVersionId: null };
  const tx = {
    pipelineVersion: {
      create: async () => {
        h.created += 1;
        return { id: "new-version", gitCommit: "abc123" };
      },
      update: async () => ({})
    },
    cIValidationRun: { findFirst: async () => (h.txBusy ? { id: "other" } : null), create: async () => ({ id: "ci1" }), update: async () => ({}) },
    nvflareDeployment: { update: async () => ({}) }
  };
  return {
    prisma: {
      study: { findUnique: async () => ({ id: "s1", orgId: "o1", slug: "x", title: "X", ethics: [], studySites: [{ code: "a", site: { id: "z" } }] }) },
      pipelineProject: {
        findUnique: async () => ({ id: "p1", studyId: "s1", giteaOwner: h.giteaOwner, giteaRepo: "r", defaultBranch: "main", templateId: "t1", templateVersionId: null, versions: [] })
      },
      requirementResponse: { findMany: async () => [] },
      cIValidationRun: { findFirst: async () => null, update: async () => ({}) },
      nvflareDeployment: { findFirst: async () => deployment, update: async () => ({}) },
      nvflareJob: { count: async () => 0 },
      pipelineVersion: { findFirst: async () => null, update: async () => ({}) },
      $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]))
    }
  };
});

import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/publish/route";

const publish = () => POST(new Request("http://x/api", { method: "POST", body: "{}" }) as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1" }) } as never) as Promise<Response>;

beforeEach(() => {
  h.giteaOwner = "o";
  h.txBusy = false;
  h.created = 0;
});

describe("publish guards", () => {
  it("answers a pipeline that was never saved with the checklist, not a bare message", async () => {
    h.giteaOwner = null;
    const response = await publish();
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("gitea_repo_required");
    expect(error.details.items.find((i: { code: string }) => i.code === "saved_code")).toMatchObject({ ok: false, text: "Save the pipeline code" });
  });

  it("refuses a second publish that slipped in after the first check, before creating anything", async () => {
    h.txBusy = true;
    const response = await publish();
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("publish_in_progress");
    expect(error.details.items.find((i: { code: string }) => i.code === "publish_idle")).toMatchObject({ ok: false });
    expect(h.created).toBe(0);
  });

  it("publishes when nothing else is going on", async () => {
    expect((await publish()).status).toBe(202);
    expect(h.created).toBe(1);
  });
});
