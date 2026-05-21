import { stat } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { readLocalSourceFiles, toReviewSourceFiles } from "@/lib/source-review";

export async function GET(_request: NextRequest, context: { params: Promise<{ pipelineVersionId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { pipelineVersionId } = await context.params;

  const version = await prisma.pipelineVersion.findUnique({
    where: { id: pipelineVersionId },
    include: {
      project: { include: { study: true, proposals: { orderBy: { createdAt: "desc" }, take: 5 } } }
    }
  });
  if (!version) return problem(404, "Pipeline version not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, version.project.studyId, "downloadPipelineBundle");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const proposal =
    version.project.proposals.find((item) => item.giteaHeadCommit === version.gitCommit || item.branchName === version.gitBranch) ??
    version.project.proposals[0];
  if (version.project.giteaOwner && version.project.giteaRepo && version.gitCommit) {
    try {
      const files = await readGiteaRepositoryFiles({
        owner: version.project.giteaOwner,
        repo: version.project.giteaRepo,
        ref: version.gitCommit
      });
      return json({
        ref: `pipelineVersion:${version.id}`,
        gitRef: version.gitCommit,
        commit: version.gitCommit,
        branchName: version.gitBranch,
        repoUrl: version.project.giteaRepoUrl,
        pullRequestUrl: proposal?.giteaPullRequestUrl ?? null,
        files: toReviewSourceFiles(files)
      });
    } catch (error) {
      if (!version.jobWorkspacePath) {
        if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
        if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
        throw error;
      }
    }
  }

  if (!version.jobWorkspacePath) {
    return problem(409, "No reviewable source is available for this pipeline version.", "pipeline_source_missing");
  }

  try {
    const info = await stat(version.jobWorkspacePath);
    if (!info.isDirectory()) return problem(409, "Pipeline version source workspace is not a directory.", "pipeline_source_missing");
    return json({
      ref: `pipelineVersion:${version.id}`,
      gitRef: version.gitCommit,
      commit: version.gitCommit,
      branchName: version.gitBranch,
      repoUrl: version.project.giteaRepoUrl,
      pullRequestUrl: proposal?.giteaPullRequestUrl ?? null,
      source: "local-workspace",
      files: await readLocalSourceFiles(version.jobWorkspacePath)
    });
  } catch {
    return problem(409, "Pipeline version source workspace is not available in this local environment.", "pipeline_source_missing");
  }
}
