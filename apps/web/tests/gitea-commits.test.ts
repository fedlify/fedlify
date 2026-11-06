import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareGiteaCommit, listGiteaCommits } from "@/lib/gitea";

describe("gitea commit helpers", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.GITEA_BASE_URL = "https://gitea.example";
    process.env.GITEA_TOKEN = "token";
    process.env.GITEA_ORG = "fedlify";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("lists commits with paging and normalises them", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([
        { sha: "c1", created: "2026-11-01T10:00:00Z", commit: { message: "m\n\nFedlify-Agent-Proposal: abc12345", author: { name: "Ana", email: "a@x" } }, parents: [{ sha: "p0" }], stats: { additions: 3, deletions: 1 } },
        { created: "2026-11-01T09:00:00Z" },
        { sha: "bad", created: "not a date" }
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    const commits = await listGiteaCommits({ owner: "fed", repo: "r", branch: "feature/x", page: 2, limit: 500 });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("/api/v1/repos/fed/r/commits?sha=feature%2Fx&page=2&limit=50");
    expect(commits).toEqual([{ sha: "c1", message: "m\n\nFedlify-Agent-Proposal: abc12345", authorName: "Ana", authorEmail: "a@x", at: "2026-11-01T10:00:00.000Z", parents: ["p0"], additions: 3, deletions: 1 }]);
  });

  it("maps a commit's changed files and returns null for an unknown commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/git/commits/known")
          ? Response.json({ sha: "known", parents: [{ sha: "p0" }], stats: { additions: 2, deletions: 0 }, files: [{ filename: "a.py", status: "changed" }, { filename: "b.py", status: "added" }, { filename: "n.py", status: "renamed", previous_filename: "o.py" }] })
          : Response.json({ message: "nf" }, { status: 404 })
      )
    );
    expect(await compareGiteaCommit({ owner: "fed", repo: "r", commit: "known" })).toEqual({
      sha: "known",
      parent: "p0",
      files: [
        { path: "a.py", status: "modified", previousPath: null },
        { path: "b.py", status: "added", previousPath: null },
        { path: "n.py", status: "renamed", previousPath: "o.py" }
      ],
      additions: 2,
      deletions: 0
    });
    expect(await compareGiteaCommit({ owner: "fed", repo: "r", commit: "missing" })).toBeNull();
  });
});
