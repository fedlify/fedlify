/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/messages
 *
 * Read-only project assistant: streams an OpenAI Responses API reply over SSE. The assistant has no tools and
 * cannot write, publish, run or release. Without `threadId` nothing is persisted; the audit entry records the
 * context hash and request sizes, not the chat or the context. With `threadId` (and AGENT_THREADS_ENABLED) the turns
 * are stored in that thread, history comes from the stored turns and the client's `history` is ignored (see
 * agent-thread-runner.ts; POST threads/[tid]/turns is the same thing).
 *
 * SSE events: raw OpenAI events, plus `fedlify.context` (first), `fedlify.done` (success) and
 * `fedlify.error` (any failure after the stream started; the stream then closes).
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { loadDiagnosticsForMessage } from "@/lib/diagnostics-access";
import { problem } from "@/lib/json";
import { buildAgentInput, buildContextPack } from "@/lib/project-context";
import { loadProjectRepo } from "@/lib/project-repo";
import { prisma } from "@/lib/prisma";
import { acquireSlot, rateLimit } from "@/lib/rate-limit";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { effectiveControlMode, openAiCodeAgentConfig } from "@/lib/runtime-config";
import { openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";
import { runAskTurn } from "@/lib/agent-thread-runner";

const filePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "" || part === ".git"), {
    message: "File paths must be relative and stay inside the repository."
  });

const requestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .max(50)
    .default([]),
  filePath: filePathSchema.optional(),
  selection: z.string().max(20000).optional(),
  /** Set by the failure buttons and site prompts; otherwise the question itself decides. */
  diagnostics: z.boolean().optional(),
  threadId: z.string().trim().min(1).max(100).optional(),
  clientTurnId: z.string().trim().min(1).max(100).optional()
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

const MAX_OUTPUT_TOKENS = 4096;

function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
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

  if (!rateLimit(`project-agent:${authResult.userId}`, 20, 60_000) || !rateLimit(`project-agent-project:${projectId}`, 60, 60_000)) {
    return problem(429, "Too many assistant requests. Wait a minute and try again.", "rate_limited");
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid assistant request.");
  const body = parsed.data;

  if (body.filePath && isSensitiveFilePath(body.filePath)) {
    return problem(400, "Secrets, key and certificate files cannot be shared with the assistant.", "file_not_shareable");
  }

  if (body.threadId) {
    const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: body.threadId });
    if (!ctx.ok) return ctx.response;
    const refused = writableThreadOrResponse(ctx);
    if (refused) return refused;
    const threadConfig = openAiCodeAgentConfig();
    if (!threadConfig) return problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured");
    return runAskTurn({
      request,
      userId: authResult.userId,
      studyId,
      projectId,
      thread: ctx.thread!,
      config: threadConfig,
      message: body.message,
      clientTurnId: body.clientTurnId,
      filePath: body.filePath,
      selection: body.selection ? { startLine: 0, endLine: 0, text: body.selection } : null,
      diagnostics: body.diagnostics
    });
  }

  // Enforced studies: this stateless route has no safety check or ledger record, so it is closed. Chats go through threads.
  if (effectiveControlMode(studyId) === "enforce") {
    return problem(409, "Please use a chat thread for this study. Start a new chat and ask again.", "thread_required");
  }

  // At most 2 live assistant streams per user in this process.
  const release = acquireSlot(`project-agent-streams:${authResult.userId}`, 2);
  if (!release) return problem(429, "Too many assistant replies in progress. Wait for one to finish.", "rate_limited");
  const bail = (response: Response) => {
    release();
    return response;
  };
  try {
  const config = openAiCodeAgentConfig();
  if (!config) return bail(problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured"));

  const repo = await loadProjectRepo(studyId, projectId);
  if (!repo.ok) return bail(repo.response);

  const [study, responses, studySites] = await Promise.all([
    prisma.study.findUnique({ where: { id: studyId } }),
    prisma.requirementResponse.findMany({ where: { studyId } }),
    prisma.studySite.findMany({ where: { studyId }, include: { dataProfile: true }, orderBy: { code: "asc" } })
  ]);
  if (!study) return bail(problem(404, "Study not found.", "not_found"));

  const diagnostics = await loadDiagnosticsForMessage({ userId: authResult.userId, studyId, projectId, message: body.message, flagged: body.diagnostics });

  const context = buildContextPack({
    study,
    requirementResponses: responses,
    sites: studySites.map((site) => ({
      code: site.code,
      name: site.name,
      institutionName: site.institutionName,
      dataProfile: site.dataProfile
    })),
    files: repo.files,
    commit: repo.commit,
    focus: body.filePath ? { path: body.filePath, selection: body.selection } : null,
    diagnostics
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: repo.project.study.orgId,
    studyId,
    action: "pipeline_project.agent_message",
    targetType: "PipelineProject",
    targetId: repo.project.id,
    metadata: {
      contextHash: context.hash,
      commit: repo.commit,
      model: config.model,
      historyMessages: body.history.length,
      messageChars: body.message.length,
      filePath: body.filePath ?? null,
      hasSelection: Boolean(body.selection),
      truncated: context.truncated.length > 0,
      diagnosticsIncluded: diagnostics !== null
    },
    request
  });

  let upstream: Response;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        input: buildAgentInput({ context, history: body.history, message: body.message }),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        stream: true
      }),
      signal: request.signal
    });
  } catch (error) {
    console.error("project-agent: upstream request failed", error instanceof Error ? error.message : "unknown error");
    return bail(problem(502, "The assistant could not reach the model provider. Try again shortly.", "upstream_error"));
  }

  if (!upstream.ok || !upstream.body) {
    // The provider's message can quote part of our API key, so log it here and send the client a fixed message.
    const errorBody = (await upstream.json().catch(() => null)) as { error?: { message?: string } } | null;
    console.error("project-agent: upstream status", upstream.status, errorBody?.error?.message ?? upstream.statusText);
    return bail(problem(502, "The model provider returned an error. Try again shortly.", "upstream_error"));
  }

  const upstreamBody = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      let completed = false;
      let failure: string | null = null;
      try {
        controller.enqueue(sse({ type: "fedlify.context", hash: context.hash, commit: repo.commit, truncated: context.truncated, requirementsAnswered: context.pack.requirementsAnswered, requirementsTotal: context.pack.requirementsTotal }));
        const reader = upstreamBody.getReader();
        let buffer = "";
        const handle = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") return;
          // Error events are not forwarded raw: provider messages can quote our API key. A fixed one follows instead.
          try {
            const event = JSON.parse(data) as { type?: string; message?: string; error?: { message?: string }; response?: { error?: { message?: string }; incomplete_details?: { reason?: string } } };
            if (event.type !== "error" && event.type !== "response.failed") controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
            if (event.type === "response.completed") completed = true;
            else if (event.type === "error") {
              console.error("project-agent: stream error event", event.message ?? event.error?.message ?? "unknown");
              failure = "The model provider reported an error.";
            }
            else if (event.type === "response.failed") {
              console.error("project-agent: response failed", event.response?.error?.message ?? "unknown");
              failure = "The model response failed.";
            }
            else if (event.type === "response.incomplete") {
              // Hit the output limit or a content filter: the text so far is valid but cut short.
              completed = true;
              controller.enqueue(sse({ type: "fedlify.notice", message: `The reply was cut short (${event.response?.incomplete_details?.reason ?? "incomplete"}).` }));
            }
          } catch {
            // A non-JSON data line is dropped; the stream state is tracked from JSON events only.
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          lines.forEach(handle);
        }
        handle(buffer);
        if (!failure && !completed) failure = "The model stream ended before the reply was complete.";
      } catch (error) {
        failure = request.signal.aborted ? "Request cancelled." : "The connection to the model provider was interrupted.";
        console.error("project-agent: stream error", error instanceof Error ? error.message : "unknown error");
      }
      release();
      try {
        if (failure) controller.enqueue(sse({ type: "fedlify.error", message: failure }));
        else controller.enqueue(sse({ type: "fedlify.done", contextHash: context.hash }));
        controller.close();
      } catch {
        // The client already disconnected; nothing left to tell it.
      }
    },
    cancel() {
      release();
      upstreamBody.cancel().catch(() => undefined);
    }
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" }
  });
  } catch (error) {
    release();
    throw error;
  }
}
