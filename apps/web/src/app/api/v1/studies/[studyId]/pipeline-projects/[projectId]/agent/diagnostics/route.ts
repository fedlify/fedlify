/**
 * GET /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/diagnostics
 *
 * Failure summaries for the workspace chat: for a failed publish or run, the title and the first error lines
 * (redacted and bounded). Read-only. The full diagnostics context the
 * assistant sees is built separately, per message.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { summarizeFailures } from "@/lib/diagnostics";
import { loadProjectDiagnostics } from "@/lib/diagnostics-loader";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
    await assertStudyAccess(authResult.userId, studyId, "viewLogs");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  if (!rateLimit(`project-agent-diagnostics:${authResult.userId}`, 30, 60_000)) return problem(429, "Too many requests. Wait a minute and try again.", "rate_limited");

  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId }, select: { studyId: true } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");

  try {
    const diagnostics = await loadProjectDiagnostics(studyId, projectId);
    return json({ failures: summarizeFailures(diagnostics) });
  } catch {
    return json({ failures: [] });
  }
}
