import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGiteaPipelineProposal } from "@/lib/gitea";

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
});
