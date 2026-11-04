import { beforeEach, describe, expect, it, vi } from "vitest";

const getGiteaBranch = vi.fn();
const readGiteaRepositoryFiles = vi.fn();
const projectCreate = vi.fn();
const projectFindFirst = vi.fn();
const versionFindFirst = vi.fn();
const audit = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/gitea-workspaces", () => ({
  publicTemplateOwner: () => "fedlify-templates",
  ensureStudyGiteaWorkspace: async () => ({ status: "ACTIVE", owner: "study-org" })
}));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {
    status = 404;
  },
  isRuntimeConfigurationError: () => false,
  getGiteaBranch: (...a: unknown[]) => getGiteaBranch(...a),
  readGiteaRepositoryFiles: (...a: unknown[]) => readGiteaRepositoryFiles(...a),
  ensureGiteaRepository: async () => ({ owner: "study-org", repo: "mine", repoUrl: "http://g/study-org/mine", defaultBranch: "main" }),
  commitGiteaFiles: async () => ({ commitSha: "c0ffee" })
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", orgId: "o1" }) },
    user: { findUnique: async () => ({ name: "A", email: "a@x.org" }) },
    pipelineProject: { findFirst: (...a: unknown[]) => projectFindFirst(...a), create: (...a: unknown[]) => projectCreate(...a) },
    pipelineVersion: { findFirst: (...a: unknown[]) => versionFindFirst(...a) },
    pipelineTemplate: { findFirst: async () => ({ id: "t1" }), create: async () => ({ id: "t1" }) }
  }
}));

import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/clone/route";

function call(body: unknown) {
  const request = new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
  return POST(request as never, { params: Promise.resolve({ studyId: "s1" }) });
}

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("clone route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readGiteaRepositoryFiles.mockResolvedValue([{ path: "client.py", content: "x" }]);
    getGiteaBranch.mockResolvedValue({ commit: { id: sha } });
    projectFindFirst.mockResolvedValue(null);
    versionFindFirst.mockResolvedValue({ id: "v1", gitCommit: sha });
    projectCreate.mockImplementation(async ({ data }: { data: unknown }) => ({ id: "p1", ...(data as object) }));
  });

  it("clones at a commit id without asking the branch endpoint, and records the template lineage", async () => {
    const response = await call({ name: "My pipeline", source: { owner: "fedlify-templates", repo: "tpl", ref: sha }, sourceKind: "template" });
    expect(response!.status).toBe(201);
    expect(getGiteaBranch).not.toHaveBeenCalled();
    expect(readGiteaRepositoryFiles).toHaveBeenCalledWith({ owner: "fedlify-templates", repo: "tpl", ref: sha });
    const data = projectCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceKind: "template", sourceRef: `fedlify-templates/tpl@${sha.slice(0, 12)}`, parentProjectId: null });
    expect(audit.mock.calls[0][0].metadata).toMatchObject({ sourceKind: "template" });
  });

  it("still resolves a branch name through the branch endpoint", async () => {
    await call({ name: "My pipeline", source: { owner: "fedlify-templates", repo: "tpl", ref: "main" } });
    expect(getGiteaBranch).toHaveBeenCalled();
  });

  it("stores and audits the copy lineage for a parent in this study", async () => {
    projectFindFirst.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === "parent" ? { id: "parent", giteaOwner: "study-org", giteaRepo: "orig" } : null));
    const response = await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig", ref: sha }, sourceKind: "copy", parentProjectId: "parent", parentVersion: "v1.0.0" });
    expect(response!.status).toBe(201);
    expect(projectCreate.mock.calls[0][0].data).toMatchObject({ sourceKind: "copy", parentProjectId: "parent", parentVersion: "v1.0.0" });
    expect(audit.mock.calls[0][0].metadata).toMatchObject({ parentProjectId: "parent", parentVersion: "v1.0.0" });
  });

  it("rejects a parent from another study, a mismatched source, and a parent on a non-copy", async () => {
    expect((await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig" }, sourceKind: "copy", parentProjectId: "elsewhere" }))!.status).toBe(404);
    projectFindFirst.mockResolvedValue({ id: "parent", giteaOwner: "study-org", giteaRepo: "other" });
    expect((await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig" }, sourceKind: "copy", parentProjectId: "parent" }))!.status).toBe(400);
    expect((await call({ name: "Copy of it", sourceKind: "template", parentProjectId: "parent" }))!.status).toBe(400);
    expect((await call({ name: "Copy of it", sourceKind: "import" }))!.status).toBe(400);
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("requires the copied commit to be the commit published as the chosen parent version", async () => {
    projectFindFirst.mockResolvedValue({ id: "parent", giteaOwner: "study-org", giteaRepo: "orig" });
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const response = await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig", ref: other }, sourceKind: "copy", parentProjectId: "parent", parentVersion: "v1" });
    expect(response!.status).toBe(400);
    expect((await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig" }, sourceKind: "copy", parentProjectId: "parent", parentVersion: "v1" }))!.status).toBe(400);
    versionFindFirst.mockResolvedValue(null);
    expect((await call({ name: "Copy of it", source: { owner: "study-org", repo: "orig", ref: sha }, sourceKind: "copy", parentProjectId: "parent", parentVersion: "v9" }))!.status).toBe(404);
    expect(projectCreate).not.toHaveBeenCalled();
  });
});
