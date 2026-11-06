/**
 * POST .../agent/threads/[tid]/turns
 *
 * Send a message in a thread. mode "ask" streams the reply over SSE (the usual events plus fedlify.turn); mode
 * "plan" makes one structured planning call and answers JSON, or SSE (fedlify.turn, fedlify.questions or
 * fedlify.plan, fedlify.done) when the client sends Accept: text/event-stream. Nothing is ever written to the repository.
 * Only the thread's author may send. History is built from stored turns, not from the client.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { problem } from "@/lib/json";
import { repoPathSchema } from "@/lib/agent-proposal";
import { openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";
import { runAskTurn, runPlanTurn } from "@/lib/agent-thread-runner";
import { TURN_MODES } from "@/lib/agent-thread-types";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import { rateLimit } from "@/lib/rate-limit";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string }> };

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8000),
  mode: z.enum(TURN_MODES),
  clientTurnId: z.string().trim().min(1).max(100),
  filePath: repoPathSchema.optional(),
  selection: z
    .object({ startLine: z.number().int().min(0).max(1_000_000), endLine: z.number().int().min(0).max(1_000_000), text: z.string().max(20000).optional() })
    .optional(),
  diagnostics: z.boolean().optional()
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
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid assistant request.");
  const body = parsed.data;
  if (body.filePath && isSensitiveFilePath(body.filePath)) {
    return problem(400, "Secrets, key and certificate files cannot be shared with the assistant.", "file_not_shareable");
  }

  if (body.mode === "ask" && (!rateLimit(`project-agent:${authResult.userId}`, 20, 60_000) || !rateLimit(`project-agent-project:${projectId}`, 60, 60_000))) {
    return problem(429, "Too many assistant requests. Wait a minute and try again.", "rate_limited");
  }
  const config = openAiCodeAgentConfig();
  if (!config) return problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured");

  const common = { request, userId: authResult.userId, studyId, projectId, thread, config };
  if (body.mode === "ask") {
    return runAskTurn({ ...common, message: body.message, clientTurnId: body.clientTurnId, filePath: body.filePath, selection: body.selection, diagnostics: body.diagnostics });
  }
  return runPlanTurn({
    ...common,
    trigger: { kind: "message", message: body.message, clientTurnId: body.clientTurnId, filePath: body.filePath, selection: body.selection, diagnostics: body.diagnostics },
    wantsSse: (request.headers.get("accept") ?? "").includes("text/event-stream")
  });
}
