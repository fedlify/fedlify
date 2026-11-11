/**
 * POST .../agent/threads/[tid]/answers
 *
 * Answer the latest open questions turn (or skip) and re-triage: the planner then asks again (up to 3 rounds
 * in total) or returns a plan. Answers are stored on the thread only; they are never written to study requirements.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { problem } from "@/lib/json";
import { latestOpenQuestions, validateAnswers } from "@/lib/agent-plan";
import { openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";
import { runPlanTurn } from "@/lib/agent-thread-runner";
import type { PlanQuestion, QuestionsPayload } from "@/lib/agent-thread-types";
import { prisma } from "@/lib/prisma";
import { assistantModelConfig } from "@/lib/runtime-config";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string }> };

const bodySchema = z.object({
  turnId: z.string().trim().min(1).max(100),
  answers: z.record(z.string().max(60), z.union([z.string().max(2000), z.array(z.string().max(2000)).max(10)])).default({}),
  skipped: z.boolean().optional()
});

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const refused = writableThreadOrResponse(ctx);
  if (refused) return refused;
  const thread = ctx.thread!;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid answers.");
  const body = parsed.data;

  const turns = await prisma.agentTurn.findMany({ where: { threadId: thread.id }, orderBy: { seq: "desc" }, take: 3, select: { id: true, seq: true, kind: true, payload: true } });
  const open = latestOpenQuestions(turns);
  // Only the newest turn may be answered, and only once: a stale or repeated answer is refused (a repeat of the same turn id is a no-op).
  if (!open || open.id !== body.turnId) {
    const previous = await prisma.agentTurn.findFirst({ where: { threadId: thread.id, clientTurnId: `answers:${body.turnId}` } });
    if (previous) return Response.json({ duplicate: true }, { status: 200 });
    return problem(409, "These questions are no longer open.", "questions_not_open");
  }
  const payload = open.payload as QuestionsPayload | null;
  const questions: PlanQuestion[] = Array.isArray(payload?.questions) ? payload.questions : [];
  const checked = validateAnswers(questions, body.answers, body.skipped === true);
  if (!checked.ok) return problem(400, checked.message);

  const config = assistantModelConfig();
  if (!config) return problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured");

  return runPlanTurn({
    request,
    userId: authResult.userId,
    studyId,
    projectId,
    thread,
    config,
    trigger: { kind: "answers", questionsTurnId: open.id, answers: checked.answers, skipped: body.skipped === true },
    wantsSse: (request.headers.get("accept") ?? "").includes("text/event-stream")
  });
}
