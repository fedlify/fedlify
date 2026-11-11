/**
 * /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals
 *
 * POST: ask the assistant for a structured change proposal (OpenAI Responses API, JSON schema output). The proposal
 *       is validated server-side before it is stored or shown. Nothing is written to the repository. With an optional
 *       threadId / planId the request and result are stored in the thread and an approved plan is required (see agent-proposal-run.ts).
 * GET:  list this project's proposals (no file contents); proposals written against an older commit become STALE.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { PROPOSAL_LIMITS, repoPathSchema } from "@/lib/agent-proposal";
import { runProposal } from "@/lib/agent-proposal-run";
import { branchHead, proposalDto, refreshStaleProposals } from "@/lib/agent-proposal-store";
import { loadControlDecorations } from "@/lib/assistant-artifacts";
import { effectiveControlMode } from "@/lib/runtime-config";
import { isRuntimeConfigurationError, GiteaApiError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const requestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .max(50)
    .default([]),
  filePath: repoPathSchema.optional(),
  filePaths: z.array(repoPathSchema).max(PROPOSAL_LIMITS.maxRequestedPaths).default([]),
  selection: z.string().max(20000).optional(),
  diagnostics: z.boolean().optional(),
  /** Optional thread link. With planId the plan must be APPROVED (409 plan_not_approved). Needs AGENT_THREADS_ENABLED. */
  threadId: z.string().trim().min(1).max(100).optional(),
  planId: z.string().trim().min(1).max(100).optional(),
  clientTurnId: z.string().trim().min(1).max(100).optional()
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

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

  try {
    await refreshStaleProposals(projectId, await branchHead(project));
  } catch (error) {
    // Staleness is re-checked on accept, so a Gitea outage here only means the list may be a little behind.
    if (!(error instanceof GiteaApiError) && !isRuntimeConfigurationError(error)) throw error;
  }
  const rows = await prisma.agentProposal.findMany({
    where: { projectId, status: { in: ["PROPOSED", "ACCEPTED", "REJECTED", "STALE"] } },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  const visible = rows.filter((row) => row.files !== null);
  if (effectiveControlMode(studyId) === "enforce") {
    const views = await loadControlDecorations(studyId, visible).catch(() => new Map());
    return json({ proposals: visible.map((row) => ({ ...proposalDto(row), ...(views.get(row.id) ?? {}) })), controlMode: "enforce" });
  }
  return json({ proposals: visible.map((row) => proposalDto(row)) });
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid proposal request.");
  const body = parsed.data;

  return runProposal({
    request,
    userId: authResult.userId,
    studyId,
    projectId,
    message: body.message,
    history: body.history,
    filePath: body.filePath,
    filePaths: body.filePaths,
    selection: body.selection,
    diagnostics: body.diagnostics,
    threadId: body.threadId,
    planId: body.planId,
    clientTurnId: body.clientTurnId
  });
}
