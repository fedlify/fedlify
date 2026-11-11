/**
 * POST .../agent/threads/[tid]/plans/[pid]/verify[?retry=1]
 *
 * The AI second check of a plan (advice only, never blocks). Only for studies that enforce the control plane.
 * Idempotent: a stored result is returned unless ?retry=1. Needs runAgent and a writable thread (its author).
 *
 * 200 { verification: { status: "CHECKING" | "PASSED" | "CONCERNS" | "UNAVAILABLE", findings: [{ kind, text }], ruleCheck, cached } }
 * 404 not found, 403 forbidden, 409 control_not_enforced | plan_not_open.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";
import { getPlanInThread } from "@/lib/agent-thread-store";
import { runSecondCheck } from "@/lib/assistant-second-check";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { effectiveControlMode } from "@/lib/runtime-config";
import { isWithheldNote } from "@/lib/terms";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string; pid: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid, pid } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const refused = writableThreadOrResponse(ctx);
  if (refused) return refused;
  if (effectiveControlMode(studyId) !== "enforce") return problem(409, "The second check is not turned on for this study.", "control_not_enforced");

  const plan = await getPlanInThread(ctx.thread!.id, pid);
  if (!plan) return problem(404, "Plan not found.", "not_found");
  if (plan.status !== "DRAFT" && plan.status !== "APPROVED") return problem(409, `This plan is already ${plan.status.toLowerCase()}.`, "plan_not_open");

  // What was asked: the last real message the person wrote before this plan was made. Later messages (follow-up questions,
  // or a message the safety check withheld) are about something else, and a withheld note says nothing about the request.
  const earlier = await prisma.agentTurn.findMany({
    where: { threadId: ctx.thread!.id, role: "USER", kind: "MESSAGE", createdAt: { lte: plan.createdAt } },
    orderBy: { seq: "desc" },
    take: 10,
    select: { content: true }
  });
  const asked = earlier.find((turn) => turn.content && !isWithheldNote(turn.content));
  const retry = new URL(request.url).searchParams.get("retry") === "1";
  const verification = await runSecondCheck({
    studyId,
    userId: authResult.userId,
    retry,
    subject: { kind: "plan", row: plan, request: asked?.content ?? plan.summary }
  });
  return json({ verification });
}
