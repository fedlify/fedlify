/**
 * GET .../agent/timeline?cursor&kind&limit      merged, newest-first list of agent proposals, commits and published versions
 * GET .../agent/timeline?commit=<sha>           read-only before/after contents of one commit (computed on demand, never stored)
 *
 * Needs `read` on the study, like the existing proposals list. It carries titles and ids, never chat text; the thread
 * link is an id only and the thread routes decide who may open it. Reading it lazily reconciles accepted proposals
 * whose commit was not recorded. Returns 404 while AGENT_THREADS_ENABLED is off.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { COMMIT_SHA, loadCommitDiff, loadTimeline, TIMELINE_FILTERS, TIMELINE_LIMITS, type TimelineFilter } from "@/lib/agent-timeline";
import { THREAD_ERROR_CODES } from "@/lib/agent-thread-types";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { agentThreadsEnabled } from "@/lib/runtime-config";

type Params = { params: Promise<{ studyId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  if (!agentThreadsEnabled()) return problem(404, "Agent threads are not enabled.", THREAD_ERROR_CODES.disabled);
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const project = await prisma.pipelineProject.findFirst({ where: { id: projectId, studyId }, include: { study: { select: { orgId: true } } } });
  if (!project) return problem(404, "Pipeline project not found for this study.", "not_found");
  if (!project.giteaOwner || !project.giteaRepo) return problem(409, "This project has no Gitea repository.", "gitea_repo_required");

  const query = request.nextUrl.searchParams;
  try {
    const commit = query.get("commit");
    if (commit !== null) {
      if (!COMMIT_SHA.test(commit)) return problem(400, "Invalid commit.");
      const diff = await loadCommitDiff({ owner: project.giteaOwner, repo: project.giteaRepo, commit });
      if (!diff) return problem(404, "Commit not found.", "not_found");
      return json(diff);
    }

    const kindParam = query.get("kind") ?? "all";
    if (!(TIMELINE_FILTERS as readonly string[]).includes(kindParam)) return problem(400, "Invalid kind.");
    const limitParam = query.get("limit");
    const limit = limitParam === null ? TIMELINE_LIMITS.defaultPage : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1) return problem(400, "Invalid limit.");

    const page = await loadTimeline({ project, actorUserId: authResult.userId, limit, cursor: query.get("cursor"), kind: kindParam as TimelineFilter });
    return json(page);
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, `Gitea request failed: ${error.message}`, "gitea_api_error");
    throw error;
  }
}
