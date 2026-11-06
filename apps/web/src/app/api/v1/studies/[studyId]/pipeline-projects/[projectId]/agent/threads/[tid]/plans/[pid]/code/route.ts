/**
 * POST .../agent/threads/[tid]/plans/[pid]/code
 *
 * Write code for an APPROVED plan: the existing proposal pipeline with the approved steps and the answers injected.
 * 409 plan_not_approved unless the plan is APPROVED; 409 plan_stale if the head or requirements moved. The result is
 * an ordinary PROPOSED proposal that a person still reviews and accepts; nothing is committed here.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { problem } from "@/lib/json";
import { PROPOSAL_LIMITS, repoPathSchema } from "@/lib/agent-proposal";
import { runProposal } from "@/lib/agent-proposal-run";
import { openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string; pid: string }> };

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8000).default("Implement the approved plan."),
  filePaths: z.array(repoPathSchema).max(PROPOSAL_LIMITS.maxRequestedPaths).default([]),
  diagnostics: z.boolean().optional()
});

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid, pid } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const refused = writableThreadOrResponse(ctx);
  if (refused) return refused;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid code request.");

  return runProposal({
    request,
    userId: authResult.userId,
    studyId,
    projectId,
    message: parsed.data.message,
    history: [],
    filePaths: parsed.data.filePaths,
    diagnostics: parsed.data.diagnostics,
    threadId: tid,
    planId: pid
  });
}
