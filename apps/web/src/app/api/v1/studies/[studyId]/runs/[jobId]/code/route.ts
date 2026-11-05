/**
 * GET /api/v1/studies/[studyId]/runs/[jobId]/code[?path=<file>]
 *
 * Read-only view of the pipeline code at the commit this run used, with each file's status against the previous
 * pipeline version. The commit always comes from the run record; the caller cannot choose a ref. A requested path must
 * be a safe relative path AND exist in that commit's file list, so nothing outside the repository is ever read.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { diffLines } from "@/lib/line-diff";
import { giteaCommitUrl, GiteaApiError, readGiteaFileAtRef } from "@/lib/gitea";
import { cachedTree } from "@/lib/gitea-tree-cache";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { isCommitSha, isSafeRepoPath } from "@/lib/repo-path";
import { ownClientNames, resolveRunViewer } from "@/lib/run-evidence";

type Params = { params: Promise<{ studyId: string; jobId: string }> };
const FILE_MAX_BYTES = 200_000;

export async function GET(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, jobId } = await params;

  const viewer = await resolveRunViewer(authResult.userId, studyId);
  if (!viewer) return problem(403, "You do not have permission to perform this action for this study.", "forbidden");

  const job = await prisma.nvflareJob.findFirst({
    where: { id: jobId, studyId },
    include: { pipelineVersion: { include: { project: true } } }
  });
  if (!job) return problem(404, "Run not found.", "not_found");
  if (viewer.scope === "site" && ownClientNames(job.selectedSites, viewer.ownSiteCodes).size === 0) {
    return problem(403, "This run does not include one of your sites.", "forbidden");
  }

  const version = job.pipelineVersion;
  const project = version.project;
  const commit = job.gitCommit ?? version.gitCommit;
  if (!isCommitSha(commit)) return problem(409, "No commit was recorded for this run, so its code cannot be shown.", "commit_not_recorded");
  if (!project.giteaOwner || !project.giteaRepo) return problem(409, "This pipeline project has no Gitea repository.", "repo_not_recorded");
  const repo = { owner: project.giteaOwner, repo: project.giteaRepo };

  const requestedPath = request.nextUrl.searchParams.get("path");
  if (requestedPath !== null && !isSafeRepoPath(requestedPath)) return problem(400, "Invalid file path.", "invalid_path");

  const parent = await prisma.pipelineVersion.findFirst({
    where: { projectId: project.id, createdAt: { lt: version.createdAt }, gitCommit: { not: null }, NOT: { gitCommit: commit } },
    orderBy: { createdAt: "desc" },
    select: { version: true, gitCommit: true }
  });
  const parentCommit = isCommitSha(parent?.gitCommit) ? parent!.gitCommit : null;

  try {
    const current = await cachedTree(repo, commit);
    const previous = parentCommit ? await cachedTree(repo, parentCommit) : null;
    const previousByPath = new Map((previous?.files ?? []).map((f) => [f.path, f.sha]));
    const files = current.files.map((f) => ({
      path: f.path,
      status: !previous ? ("unknown" as const) : !previousByPath.has(f.path) ? ("added" as const) : previousByPath.get(f.path) !== f.sha ? ("modified" as const) : ("unchanged" as const)
    }));
    const currentPaths = new Set(current.files.map((f) => f.path));
    const deletedPaths = previous ? previous.files.filter((f) => !currentPaths.has(f.path)).map((f) => f.path) : [];

    let file: { path: string; content: string | null; truncated: boolean; diff: ReturnType<typeof diffLines> | null; parentContentMissing: boolean } | null = null;
    if (requestedPath !== null) {
      if (!currentPaths.has(requestedPath)) return problem(404, "File not found at this run's commit.", "not_found");
      const raw = await readGiteaFileAtRef({ ...repo, ref: commit, path: requestedPath });
      const truncated = raw !== null && Buffer.byteLength(raw) > FILE_MAX_BYTES;
      const content = raw === null ? null : truncated ? raw.slice(0, FILE_MAX_BYTES) : raw;
      let diff: ReturnType<typeof diffLines> | null = null;
      let parentContentMissing = false;
      if (parentCommit && content !== null && !truncated) {
        const before = previousByPath.has(requestedPath) ? await readGiteaFileAtRef({ ...repo, ref: parentCommit, path: requestedPath }) : "";
        if (before === null) parentContentMissing = true;
        else diff = diffLines(before, content);
      }
      file = { path: requestedPath, content, truncated, diff, parentContentMissing };
    }

    return json(
      {
        commit,
        commitRecordedOnRun: Boolean(job.gitCommit),
        commitUrl: project.giteaRepoUrl ? giteaCommitUrl(project.giteaRepoUrl, commit) : null,
        repoUrl: project.giteaRepoUrl ?? null,
        pipelineVersion: version.version,
        parent: parent && parentCommit ? { version: parent.version, commit: parentCommit } : null,
        imageDigest: job.imageDigest ?? null,
        siteDigests: viewer.scope === "full" ? (job.siteDigests ?? null) : null,
        treeTruncated: current.truncated,
        files,
        deletedPaths,
        file
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GiteaApiError) return problem(502, `Code host could not be read: ${error.message}`, "gitea_unavailable");
    if (error instanceof Error && error.name === "RuntimeConfigurationError") return problem(503, "The code host is not configured.", "gitea_not_configured");
    throw error;
  }
}
