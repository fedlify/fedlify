/** POST .../agent/proposals/[id]/reject: a human declines a proposal. Nothing is written to the repository. */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { canTransition } from "@/lib/agent-proposal";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

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
  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId }, include: { study: true } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  const row = await prisma.agentProposal.findFirst({ where: { id, projectId } });
  if (!row || row.files === null) return problem(404, "Proposal not found.", "not_found");
  if (!canTransition(row.status, "REJECTED")) return problem(409, `This proposal is already ${row.status.toLowerCase()}.`, "proposal_not_open");

  // Guarded by the current status so a concurrent accept cannot be overwritten.
  const result = await prisma.agentProposal.updateMany({
    where: { id, projectId, status: { in: ["PROPOSED", "STALE"] } },
    data: { status: "REJECTED", decidedAt: new Date() }
  });
  if (result.count === 0) return problem(409, "This proposal was already decided.", "proposal_not_open");

  await audit({
    actorUserId: authResult.userId,
    orgId: project.study.orgId,
    studyId,
    action: "pipeline_project.agent_reject",
    targetType: "PipelineProject",
    targetId: project.id,
    metadata: { proposalId: id, rejectedBy: authResult.userId, contextHash: row.contextHash, baseCommit: row.baseCommit },
    request
  });
  return json({ proposal: { id, status: "REJECTED" } });
}
