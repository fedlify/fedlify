/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/checks
 *
 * Runs the static publish rules (validate_repo.py, ported to TypeScript) in-process against the files at
 * the head of the project branch. Read-only. Unit tests and Python syntax run only at publish.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { loadProjectRepo } from "@/lib/project-repo";
import { rateLimit } from "@/lib/rate-limit";
import { checkRepoFiles } from "@/lib/repo-checks";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string; projectId: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (!rateLimit(`project-checks:${authResult.userId}`, 20, 60_000)) {
    return problem(429, "Too many check runs. Wait a minute and try again.", "rate_limited");
  }

  const repo = await loadProjectRepo(studyId, projectId);
  if (!repo.ok) return repo.response;

  const report = checkRepoFiles(repo.files);
  return json({ commit: repo.commit, branch: repo.project.defaultBranch, fileCount: repo.files.length, ...report });
}
