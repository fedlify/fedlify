import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitGiteaFiles, createGiteaPipelineProposal } from "@/lib/gitea";

describe("gitea client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GITEA_BASE_URL = "https://gitea.example";
    process.env.GITEA_TOKEN = "token";
    process.env.GITEA_ORG = "fedlify";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("creates repo, branch, files, and pull request metadata", async () => {
    let branchReads = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v1/orgs/fedlify/repos")) {
        return Response.json({ name: "fedlify-study-pipeline", html_url: "https://gitea.example/fedlify/fedlify-study-pipeline", default_branch: "main" });
      }
      if (url.endsWith("/branches/fedlify%2Fstudy-1")) {
        branchReads += 1;
        return branchReads === 1
          ? Response.json({}, { status: 404 })
          : Response.json({ name: "fedlify/study-1", commit: { id: "commit-1" } });
      }
      if (url.endsWith("/api/v1/repos/fedlify/fedlify-study-pipeline/branches")) {
        return Response.json({ name: "fedlify/study-1", commit: { id: "base" } });
      }
      if (url.includes("/contents/README.md?ref=")) return Response.json({}, { status: 404 });
      if (url.includes("/contents/README.md")) return Response.json({ commit: { sha: "commit-1" } });
      if (url.endsWith("/pulls")) return Response.json({ number: 7, html_url: "https://gitea.example/fedlify/fedlify-study-pipeline/pulls/7", head: { sha: "commit-1" } });
      return Response.json({ message: `Unhandled ${init?.method ?? "GET"} ${url}` }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const proposal = await createGiteaPipelineProposal({
      repoName: "fedlify-study-pipeline",
      projectName: "Study Pipeline",
      description: "Pipeline repo",
      branchName: "fedlify/study-1",
      files: [{ path: "README.md", content: "# Pipeline" }],
      pullRequestBody: "Review"
    });

    expect(proposal.commitSha).toBe("commit-1");
    expect(proposal.pullRequestNumber).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitea.example/api/v1/repos/fedlify/fedlify-study-pipeline/pulls",
      expect.objectContaining({ method: "POST" })
    );
  });

  describe("commitGiteaFiles", () => {
    function stubRepo(onCommit: (body: { files: Array<{ operation: string; path: string; sha?: string }> }) => Response) {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/repos/study-org/pipe/branches/main")) return Response.json({ name: "main", commit: { id: "head-1" } });
        if (url.includes("/repos/study-org/pipe/git/trees/head-1")) {
          return Response.json({
            tree: [
              { path: "client.py", type: "blob", sha: "sha-client" },
              { path: "old.py", type: "blob", sha: "sha-old" },
              { path: "job", type: "tree", sha: "sha-dir" }
            ]
          });
        }
        if (url.endsWith("/repos/study-org/pipe/contents") && init?.method === "POST") return onCommit(JSON.parse(String(init.body)));
        return Response.json({ message: `Unhandled ${init?.method ?? "GET"} ${url}` }, { status: 500 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("maps edits to create, update, and delete operations in one commit", async () => {
      let committed: Array<{ operation: string; path: string; sha?: string }> = [];
      stubRepo((body) => {
        committed = body.files;
        return Response.json({ commit: { sha: "head-2" } });
      });

      const result = await commitGiteaFiles({
        owner: "study-org",
        repo: "pipe",
        branchName: "main",
        baseCommit: "head-1",
        message: "Save",
        files: [
          { path: "client.py", content: "print('v2')" },
          { path: "model.py", content: "class Model: ..." },
          { path: "old.py", content: null },
          { path: "missing.py", content: null }
        ]
      });

      expect(result).toEqual({ commitSha: "head-2", changed: 3 });
      expect(committed.map(({ operation, path, sha }) => ({ operation, path, sha }))).toEqual([
        { operation: "update", path: "client.py", sha: "sha-client" },
        { operation: "create", path: "model.py", sha: undefined },
        { operation: "delete", path: "old.py", sha: "sha-old" }
      ]);
    });

    it("rejects a save based on a stale commit", async () => {
      const fetchMock = stubRepo(() => Response.json({ commit: { sha: "never" } }));

      await expect(
        commitGiteaFiles({ owner: "study-org", repo: "pipe", branchName: "main", baseCommit: "abc1234", message: "Save", files: [{ path: "client.py", content: "x" }] })
      ).rejects.toMatchObject({ status: 409 });
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/contents$/), expect.anything());
    });

    it("does not create an empty commit when nothing changed", async () => {
      const fetchMock = stubRepo(() => Response.json({ commit: { sha: "never" } }));

      const result = await commitGiteaFiles({ owner: "study-org", repo: "pipe", branchName: "main", message: "Save", files: [{ path: "gone.py", content: null }] });

      expect(result).toEqual({ commitSha: "head-1", changed: 0 });
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/contents$/), expect.anything());
    });
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order, bounds concurrency and propagates errors", async () => {
    const { mapWithConcurrency } = await import("@/lib/gitea");
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 0]);
    expect(peak).toBeLessThanOrEqual(3);
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("x");
        return n;
      })
    ).rejects.toThrow("x");
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
  });
});
