/**
 * GET /api/v1/studies/[studyId]/pipeline-version-source
 *
 * Returns the source files from the study's latest approved pipeline version
 * so the pipeline-agent page can show existing code when adjusting.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const BINARY_EXTENSIONS = new Set([".npy", ".pt", ".pth", ".h5", ".pkl", ".ckpt", ".onnx", ".bin"]);
const IGNORED_DIRS = new Set([".git", "__pycache__", ".next", "node_modules"]);
const MAX_FILE_SIZE = 512 * 1024; // 512 KB

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, (error as Error).message, "forbidden");
    throw error;
  }

  // Find the latest approved pipeline version for this study
  const pipelineVersion = await prisma.pipelineVersion.findFirst({
    where: {
      project: { studyId },
      approvalStatus: "APPROVED"
    },
    include: {
      project: {
        select: { giteaOwner: true, giteaRepo: true, giteaDefaultBranch: true }
      }
    },
    orderBy: { approvedAt: "desc" }
  });

  if (!pipelineVersion?.project?.giteaOwner || !pipelineVersion.project.giteaRepo) {
    return json({ files: [], message: "No approved pipeline version with Gitea source found." });
  }

  try {
    const rawFiles = await readGiteaRepositoryFiles({
      owner: pipelineVersion.project.giteaOwner,
      repo: pipelineVersion.project.giteaRepo,
      ref: pipelineVersion.gitCommit ?? pipelineVersion.project.giteaDefaultBranch ?? "main"
    });

    const files = rawFiles
      .filter((f) => {
        const ext = f.path.slice(f.path.lastIndexOf("."));
        const parts = f.path.split("/");
        if (parts.some((p) => IGNORED_DIRS.has(p))) return false;
        if (BINARY_EXTENSIONS.has(ext)) return false;
        if ((f.content?.length ?? 0) > MAX_FILE_SIZE) return false;
        return true;
      })
      .map((f) => ({
        path: f.path,
        content: f.content ?? "",
        language: languageForPath(f.path)
      }));

    return json({ files, version: pipelineVersion.version, commit: pipelineVersion.gitCommit });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, (error as Error).message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return json({ files: [], message: "Could not load pipeline source." });
    throw error;
  }
}

function languageForPath(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".conf") || path.endsWith(".toml")) return "ini";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".sh")) return "shell";
  return "plaintext";
}
