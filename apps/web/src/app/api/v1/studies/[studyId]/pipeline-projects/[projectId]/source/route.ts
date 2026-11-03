/**
 * GET /api/v1/studies/[studyId]/pipeline-projects/[projectId]/source
 *
 * The project's files at the head of its branch, in the payload shape CodeReviewPanel renders.
 * `commit` is the base commit the editor must send back on Save (stale saves are rejected).
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { getGiteaBranch, giteaBranchTreeUrl, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string; projectId: string }> };

const LANGUAGES: Record<string, string> = {
  py: "python",
  json: "json",
  conf: "plaintext",
  md: "markdown",
  txt: "plaintext",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  toml: "ini",
  cfg: "ini"
};

function languageFor(path: string): string {
  return LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  if (!project.giteaOwner || !project.giteaRepo) return problem(409, "This project has no Gitea repository.", "gitea_repo_required");

  try {
    const branch = await getGiteaBranch({ owner: project.giteaOwner, repo: project.giteaRepo, branchName: project.defaultBranch });
    const commit = branch.commit?.id ?? branch.commit?.sha ?? null;
    const files = commit ? await readGiteaRepositoryFiles({ owner: project.giteaOwner, repo: project.giteaRepo, ref: commit }) : [];
    return json({
      source: "gitea",
      ref: project.defaultBranch,
      gitRef: project.defaultBranch,
      commit,
      branchName: project.defaultBranch,
      repoUrl: project.giteaRepoUrl,
      branchUrl: project.giteaRepoUrl ? giteaBranchTreeUrl(project.giteaRepoUrl, project.defaultBranch) : null,
      files: files.map((file) => ({ ...file, language: languageFor(file.path) }))
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }
}
