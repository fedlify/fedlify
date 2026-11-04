import { beforeEach, describe, expect, it, vi } from "vitest";

const commitGiteaFiles = vi.fn();
const projectCreate = vi.fn();
const projectFindFirst = vi.fn();
const audit = vi.fn();
const assertStudyAccess = vi.fn();
const fetchPublicArchive = vi.fn();
const templateFindFirst = vi.fn();
const getGiteaBranch = vi.fn();
const getGiteaTag = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: (...a: unknown[]) => assertStudyAccess(...a), isForbiddenError: (e: unknown) => e instanceof Error && e.message === "forbidden" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/runtime-config", () => ({ giteaConfig: () => ({ baseUrl: "https://git.fedlify.example" }) }));
vi.mock("@/lib/gitea-workspaces", () => ({
  publicTemplateOwner: () => "fedlify-templates",
  ensureStudyGiteaWorkspace: async () => ({ status: "ACTIVE", owner: "study-org" })
}));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {
    status = 404;
  },
  getGiteaTag: (...a: unknown[]) => getGiteaTag(...a),
  isRuntimeConfigurationError: () => false,
  getGiteaBranch: (...a: unknown[]) => getGiteaBranch(...a),
  readGiteaRepositoryFiles: async () => [{ path: "client.py", content: "x=1" }],
  ensureGiteaRepository: async () => ({ owner: "study-org", repo: "mine", repoUrl: "http://g/study-org/mine", defaultBranch: "main" }),
  commitGiteaFiles: (...a: unknown[]) => commitGiteaFiles(...a)
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    study: { findUnique: async () => ({ id: "s1", orgId: "o1" }) },
    user: { findUnique: async () => ({ name: "A", email: "a@x.org" }) },
    pipelineProject: { findFirst: (...a: unknown[]) => projectFindFirst(...a), create: (...a: unknown[]) => projectCreate(...a) },
    pipelineTemplate: { findFirst: (...a: unknown[]) => templateFindFirst(...a) }
  }
}));
vi.mock("@/lib/repo-import", async (original) => ({ ...(await original<typeof import("@/lib/repo-import")>()), fetchPublicArchive: (...a: unknown[]) => fetchPublicArchive(...a) }));

import JSZip from "jszip";
import { POST } from "@/app/api/v1/studies/[studyId]/pipeline-projects/import/route";

function call(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request("http://x/api", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }) as never, { params: Promise.resolve({ studyId: "s1" }) });
}

const client = "import nvflare.client as flare\nflare.init()\nwhile flare.is_running():\n    m = flare.receive()\n    flare.send(m)\n";

describe("import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertStudyAccess.mockResolvedValue(undefined);
    projectFindFirst.mockResolvedValue(null);
    templateFindFirst.mockResolvedValue({ id: "t1" });
    getGiteaBranch.mockResolvedValue({ commit: { id: "0123456789abcdef0123456789abcdef01234567" } });
    commitGiteaFiles.mockResolvedValue({ commitSha: "c0ffee", changed: 1 });
    projectCreate.mockImplementation(async ({ data }: { data: unknown }) => ({ id: "p1", ...(data as object) }));
  });

  it("requires runAgent on the study", async () => {
    assertStudyAccess.mockRejectedValue(new Error("forbidden"));
    expect((await call({ kind: "files", name: "My import", files: [{ path: "a.py", content: "x" }] }))!.status).toBe(403);
    expect(assertStudyAccess).toHaveBeenCalledWith("u1", "s1", "runAgent");
    expect(commitGiteaFiles).not.toHaveBeenCalled();
  });

  it("rejects bad input and unsafe URLs before any request is made", async () => {
    expect((await call({ kind: "nope" }))!.status).toBe(400);
    expect((await call({ kind: "git", url: "http://github.com/a/b", dryRun: true }))!.status).toBe(400);
    expect((await call({ kind: "git", url: "https://169.254.169.254/a/b", dryRun: true }))!.status).toBe(400);
    expect((await call({ kind: "git", url: "https://evil.example/a/b", dryRun: true }))!.status).toBe(400);
    expect((await call({ kind: "files", files: [{ path: "a.py", content: "x" }] }))!.status).toBe(400); // no name
    expect(fetchPublicArchive).not.toHaveBeenCalled();
    expect(commitGiteaFiles).not.toHaveBeenCalled();
  });

  it("dry run returns the server's report and creates nothing", async () => {
    const zip = new JSZip();
    zip.file("repo-main/train.py", "import requests\nrequests.get('http://x')\n");
    fetchPublicArchive.mockResolvedValue(await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
    const response = await call({ kind: "git", url: "https://github.com/acme/model", dryRun: true });
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.report.blocking.map((f: { id: string }) => f.id)).toContain("network");
    expect(fetchPublicArchive).toHaveBeenCalledWith("https://codeload.github.com/acme/model/zip/HEAD");
    expect(commitGiteaFiles).not.toHaveBeenCalled();
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("creates the repo through commitGiteaFiles, drops data files, records the import and audits without content", async () => {
    const response = await call({
      kind: "files",
      name: "My import",
      acknowledgeBlocking: true,
      files: [{ path: "client.py", content: client }, { path: "data/patients.csv", content: "id\n1\n" }]
    });
    expect(response!.status).toBe(201);
    const commit = commitGiteaFiles.mock.calls[0][0];
    expect(commit.owner).toBe("study-org");
    expect(commit.files.map((f: { path: string }) => f.path)).toEqual(["client.py"]);
    const data = projectCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceKind: "import", parentProjectId: null, parentVersion: null });
    expect(data.sourceRef).toMatch(/^zip:[0-9a-f]{64}$/);
    const meta = audit.mock.calls[0][0].metadata;
    expect(audit.mock.calls[0][0].action).toBe("pipeline_project.import");
    expect(meta).toMatchObject({ dropped: 1, fileCount: 1 });
    expect(JSON.stringify(meta)).not.toContain("flare.init");
  });

  it("refuses an import with a credential, names the path only, and commits nothing", async () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    const response = await call({ kind: "files", name: "My import", files: [{ path: "client.py", content: client }, { path: "cfg.py", content: `K="${secret}"` }] });
    expect(response!.status).toBe(422);
    const text = JSON.stringify(await response!.json());
    expect(text).toContain("secrets_found");
    expect(text).toContain("cfg.py");
    expect(text).not.toContain(secret);
    expect(commitGiteaFiles).not.toHaveBeenCalled();
  });

  it("records a git import with its normalised URL and ref, and never a credential", async () => {
    const zip = new JSZip();
    zip.file("model-main/client.py", client);
    fetchPublicArchive.mockResolvedValue(await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
    const response = await call({ kind: "git", url: "https://github.com/acme/model.git", ref: "v1", name: "From github", acknowledgeBlocking: true });
    expect(response!.status).toBe(201);
    expect(projectCreate.mock.calls[0][0].data.sourceRef).toBe("https://github.com/acme/model@v1");
    expect(commitGiteaFiles.mock.calls[0][0].files.map((f: { path: string }) => f.path)).toEqual(["client.py"]);
  });

  it("only imports from this Gitea for this study's or the template organization", async () => {
    expect((await call({ kind: "git", url: "https://git.fedlify.example/other-study/repo", dryRun: true }))!.status).toBe(403);
    expect((await call({ kind: "git", url: "https://git.fedlify.example/study-org/repo", dryRun: true }))!.status).toBe(200);
  });

  it("refuses an oversized body before parsing", async () => {
    expect((await call("{}", { "content-length": String(9 * 1024 * 1024) }))!.status).toBe(413);
    expect((await call(JSON.stringify({ kind: "files", name: "x y z", files: [{ path: "a.py", content: "x".repeat(9 * 1024 * 1024) }] })))!.status).toBe(413);
    expect(commitGiteaFiles).not.toHaveBeenCalled();
  });

  it("does not create an import with blocking findings unless acknowledged, and reports them", async () => {
    const files = [{ path: "client.py", content: client }];
    const refused = await call({ kind: "files", name: "My import", files });
    expect(refused!.status).toBe(422);
    expect((await refused!.json()).error).toMatchObject({ code: "blocking_unacknowledged" });
    expect(commitGiteaFiles).not.toHaveBeenCalled();
    const ok = await call({ kind: "files", name: "My import", files, acknowledgeBlocking: true });
    expect(ok!.status).toBe(201);
    const body = await ok!.json();
    expect(body.publishable).toBe(false);
    expect(body.blocking.length).toBeGreaterThan(0);
  });

  it("answers 503 and creates nothing when the starter template row is missing", async () => {
    templateFindFirst.mockResolvedValue(null);
    const response = await call({ kind: "files", name: "My import", acknowledgeBlocking: true, files: [{ path: "client.py", content: client }] });
    expect(response!.status).toBe(503);
    expect(commitGiteaFiles).not.toHaveBeenCalled();
  });

  it("audits security rejections with codes and paths only, and git previews", async () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    await call({ kind: "files", name: "My import", files: [{ path: "client.py", content: client }, { path: "cfg.py", content: `K="${secret}"` }] });
    await call({ kind: "git", url: "https://git.fedlify.example/other-study/repo", dryRun: true });
    const actions = audit.mock.calls.map((c) => [c[0].action, c[0].metadata.code]);
    expect(actions).toContainEqual(["pipeline_project.import_rejected", "secrets_found"]);
    expect(actions).toContainEqual(["pipeline_project.import_rejected", "source_not_allowed"]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(secret);
  });

  it("falls back to the tag endpoint when a Gitea ref is not a branch", async () => {
    const { GiteaApiError } = await import("@/lib/gitea");
    getGiteaBranch.mockRejectedValue(new GiteaApiError("nf", 404));
    getGiteaTag.mockResolvedValue({ commit: { sha: "abcdef0123456789abcdef0123456789abcdef01" } });
    const response = await call({ kind: "git", url: "https://git.fedlify.example/study-org/repo", ref: "v1", dryRun: true });
    expect(response!.status).toBe(200);
    expect(getGiteaTag).toHaveBeenCalledWith({ owner: "study-org", repo: "repo", tagName: "v1" });
  });

  it("reports the repo when the project row cannot be written", async () => {
    projectCreate.mockRejectedValue(new Error("db down"));
    const response = await call({ kind: "files", name: "My import", acknowledgeBlocking: true, files: [{ path: "client.py", content: client }] });
    expect(response!.status).toBe(500);
    expect(JSON.stringify(await response!.json())).toContain("study-org/mine");
  });
});
