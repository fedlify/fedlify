/**
 * POST .../agent/proposals/[id]/verify[?retry=1]
 *
 * The AI second check of a code proposal (advice only, never blocks). Only for studies that enforce the control plane.
 * Idempotent: a stored result is returned unless ?retry=1. Needs runAgent.
 *
 * 200 { verification: { status: "CHECKING" | "PASSED" | "CONCERNS" | "UNAVAILABLE", findings: [{ kind, text }], ruleCheck, cached } }
 * 404 not found, 403 forbidden, 409 control_not_enforced | proposal_not_open.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { runSecondCheck } from "@/lib/assistant-second-check";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { effectiveControlMode } from "@/lib/runtime-config";

type Params = { params: Promise<{ studyId: string; projectId: string; id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, id } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  if (effectiveControlMode(studyId) !== "enforce") return problem(409, "The second check is not turned on for this study.", "control_not_enforced");

  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId }, select: { id: true, studyId: true } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  const row = await prisma.agentProposal.findFirst({ where: { id, projectId } });
  if (!row || row.files === null) return problem(404, "Proposal not found.", "not_found");
  if (row.status !== "PROPOSED" && row.status !== "ACCEPTED") return problem(409, `This proposal is already ${row.status.toLowerCase()}.`, "proposal_not_open");

  const plan = row.planId ? await prisma.agentPlan.findUnique({ where: { id: row.planId }, select: { summary: true, steps: true } }) : null;
  const retry = new URL(request.url).searchParams.get("retry") === "1";
  const verification = await runSecondCheck({
    studyId,
    userId: authResult.userId,
    retry,
    subject: { kind: "proposal", row, plan }
  });
  return json({ verification });
}
