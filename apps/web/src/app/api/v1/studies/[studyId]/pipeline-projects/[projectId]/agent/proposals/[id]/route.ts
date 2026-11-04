/** GET one proposal with the full proposed file contents (for the diff view). */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { branchHead, markStale, proposalDto, isProposalStale } from "@/lib/agent-proposal-store";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string; projectId: string; id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, id } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  let row = await prisma.agentProposal.findFirst({ where: { id, projectId } });
  if (!row || row.files === null) return problem(404, "Proposal not found.", "not_found");

  if (row.status === "PROPOSED") {
    try {
      const head = await branchHead(project);
      if (head && isProposalStale(row, head) && (await markStale(row.id))) {
        row = (await prisma.agentProposal.findFirst({ where: { id, projectId } })) ?? row;
      }
    } catch (error) {
      if (!(error instanceof GiteaApiError) && !isRuntimeConfigurationError(error)) throw error;
    }
  }
  return json({ proposal: proposalDto(row, { withContent: true }) });
}
