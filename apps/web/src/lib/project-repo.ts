import type { NextResponse } from "next/server";
import { getGiteaBranch, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import type { RepoFile } from "@/lib/repo-checks";

// Commits are immutable, so files can be cached by owner/repo/commit. This saves one Gitea call per file on repeated
// assistant and check requests. Small and per-process; a shared cache would be needed across replicas.
const FILE_CACHE_MAX = 4;
const fileCache = new Map<string, RepoFile[]>();

async function filesAtCommit(owner: string, repo: string, commit: string): Promise<RepoFile[]> {
  const key = `${owner}/${repo}@${commit}`;
  const hit = fileCache.get(key);
  if (hit) {
    fileCache.delete(key);
    fileCache.set(key, hit);
    return hit;
  }
  const files = await readGiteaRepositoryFiles({ owner, repo, ref: commit });
  fileCache.set(key, files);
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value as string);
  return files;
}

/** Load a project's files at the head of its branch, mapping failures to API problem responses. */
export async function loadProjectRepo(studyId: string, projectId: string): Promise<
  | { ok: true; project: NonNullable<Awaited<ReturnType<typeof findProject>>>; commit: string | null; files: RepoFile[] }
  | { ok: false; response: NextResponse }
> {
  const project = await findProject(projectId);
  if (!project || project.studyId !== studyId) {
    return { ok: false, response: problem(404, "Pipeline project not found for this study.", "not_found") };
  }
  if (!project.giteaOwner || !project.giteaRepo) {
    return { ok: false, response: problem(409, "This project has no Gitea repository.", "gitea_repo_required") };
  }
  try {
    const branch = await getGiteaBranch({ owner: project.giteaOwner, repo: project.giteaRepo, branchName: project.defaultBranch });
    const commit = branch.commit?.id ?? branch.commit?.sha ?? null;
    const files = commit ? await filesAtCommit(project.giteaOwner, project.giteaRepo, commit) : [];
    return { ok: true, project, commit, files };
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return { ok: false, response: problem(503, error.message, "gitea_not_configured") };
    if (error instanceof GiteaApiError) return { ok: false, response: problem(502, error.message, "gitea_api_error") };
    throw error;
  }
}

function findProject(projectId: string) {
  return prisma.pipelineProject.findUnique({ where: { id: projectId }, include: { study: { select: { id: true, orgId: true } } } });
}
