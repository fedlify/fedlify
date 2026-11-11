/**
 * Model-calling halves of the thread routes: an ask turn (streamed over SSE) and a plan turn (one structured call).
 * Route files may only export HTTP handlers, so the shared logic lives here.
 *
 * Fail closed: the user turn is stored before the model is called. If that insert fails, the model is not called.
 * Audit metadata carries ids, counts and hashes, never message, answer or plan text.
 */

import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { loadDiagnosticsForMessage } from "@/lib/diagnostics-access";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { acquireSlot, rateLimit } from "@/lib/rate-limit";
import { loadProjectRepo } from "@/lib/project-repo";
import { boundHistory, buildAgentInput, buildContextPack, type BuiltContext } from "@/lib/project-context";
import { blankRequirements, questionState, requirementsHash, parsePlanResponse, PLAN_JSON_SCHEMA, type NormalizedPlanResult } from "@/lib/agent-plan";
import { ASK_PROMPT_VERSION, buildPlanInput, PLAN_PROMPT_VERSION } from "@/lib/agent-plan-prompt";
import {
  appendTurn,
  createPlan,
  finalizeTurn,
  linkTurn,
  loadHistory,
  planDto,
  setThreadMode,
  turnDto
} from "@/lib/agent-thread-store";
import {
  AUDIT_ACTIONS,
  LIMITS,
  THREAD_SSE_EVENTS,
  type EditorSelection,
  type PlanEventData,
  type QuestionsEventData,
  type QuestionsPayload,
  type TurnDto,
  type TurnEventData,
  type TurnMode
} from "@/lib/agent-thread-types";
import { sha256 } from "@/lib/crypto";
import { randomUUID } from "node:crypto";
import { guardAssistantTurn, openAssistantTurn, type AssistantOutcome } from "@/lib/assistant-control";
import { invalidateApprovalBinding, recordPlanControl } from "@/lib/assistant-artifacts";
import { storeStop, stopStream, type StoredStop } from "@/lib/assistant-stop";

export const AGENT_PLAN_INVALID_ACTION = "pipeline_project.agent_plan_invalid";

type RepoOk = Extract<Awaited<ReturnType<typeof loadProjectRepo>>, { ok: true }>;
export type ThreadLike = { id: string; mode: string };
export type AgentConfig = { apiKey: string; model: string };

const ASK_MAX_OUTPUT_TOKENS = 4096;
const PLAN_MAX_OUTPUT_TOKENS = 8000;
const PLAN_TIMEOUT_MS = 150_000;

function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function namedSse(event: string, data: unknown): Uint8Array {
  return sse({ type: event, ...(data as object) });
}

type LoadedContext = { ok: true; repo: RepoOk; context: BuiltContext; responses: Array<{ requirementId: string; answer: string }>; diagnosticsIncluded: boolean } | { ok: false; response: Response };

async function loadTurnContext(input: { userId: string; studyId: string; projectId: string; message: string; filePath?: string | null; selectionText?: string | null; diagnostics?: boolean }): Promise<LoadedContext> {
  const repo = await loadProjectRepo(input.studyId, input.projectId);
  if (!repo.ok) return repo;
  const [study, responses, sites] = await Promise.all([
    prisma.study.findUnique({ where: { id: input.studyId } }),
    prisma.requirementResponse.findMany({ where: { studyId: input.studyId } }),
    prisma.studySite.findMany({ where: { studyId: input.studyId }, include: { dataProfile: true }, orderBy: { code: "asc" } })
  ]);
  if (!study) return { ok: false, response: problem(404, "Study not found.", "not_found") };
  const diagnostics = await loadDiagnosticsForMessage({ userId: input.userId, studyId: input.studyId, projectId: input.projectId, message: input.message, flagged: input.diagnostics });
  const context = buildContextPack({
    study,
    requirementResponses: responses,
    sites: sites.map((site) => ({ code: site.code, name: site.name, institutionName: site.institutionName, dataProfile: site.dataProfile })),
    files: repo.files,
    commit: repo.commit,
    focus: input.filePath ? { path: input.filePath, selection: input.selectionText ?? undefined } : null,
    diagnostics
  });
  return { ok: true, repo, context, responses, diagnosticsIncluded: diagnostics !== null };
}

// ---------- ask ----------

export type AskTurnInput = {
  request: NextRequest;
  userId: string;
  studyId: string;
  projectId: string;
  thread: ThreadLike;
  config: AgentConfig;
  message: string;
  clientTurnId?: string | null;
  filePath?: string | null;
  selection?: EditorSelection | null;
  diagnostics?: boolean;
};

async function existingTurn(threadId: string, clientTurnId: string | null | undefined) {
  if (!clientTurnId) return null;
  return prisma.agentTurn.findFirst({ where: { threadId, clientTurnId } });
}

/** Persisted ask turn: stores the user turn, streams the reply, and finalizes the assistant turn as done, error or stopped. */
export async function runAskTurn(input: AskTurnInput): Promise<Response> {
  const { request, userId, studyId, projectId, thread, config } = input;
  const duplicate = await existingTurn(thread.id, input.clientTurnId);
  if (duplicate) return json({ duplicate: true, turn: turnDto(duplicate) });

  const release = acquireSlot(`project-agent-streams:${userId}`, 2);
  if (!release) return problem(429, "Too many assistant replies in progress. Wait for one to finish.", "rate_limited");
  const bail = (response: Response) => {
    release();
    return response;
  };
  try {
    const loaded = await loadTurnContext({ userId, studyId, projectId, message: input.message, filePath: input.filePath, selectionText: input.selection?.text, diagnostics: input.diagnostics });
    if (!loaded.ok) return bail(loaded.response);
    const { repo, context } = loaded;

    // Enforced studies only (a no-op otherwise): the safety check finishes BEFORE the message is stored or any model is called.
    const gate = await guardAssistantTurn({
      studyId,
      projectId,
      threadId: thread.id,
      userId,
      mode: "ask",
      clientTurnId: input.clientTurnId ?? randomUUID(),
      userText: input.message,
      selection: input.selection?.text ?? null
    });
    if (gate.enforced && gate.blocked) {
      try {
        const stored = await storeStop({ gate, request, userId, orgId: repo.project.study.orgId, studyId, projectId, threadId: thread.id, userTurn: { clientTurnId: input.clientTurnId ?? null }, contextHash: context.hash, baseCommit: repo.commit });
        release();
        return stopStream(stored);
      } catch (error) {
        console.error("agent thread: could not store the stop notice", error instanceof Error ? error.message : "unknown error");
        return bail(problem(503, gate.stop.why, "assistant_stopped"));
      }
    }

    let userTurn: Awaited<ReturnType<typeof appendTurn>>["turn"];
    let assistantTurn: Awaited<ReturnType<typeof appendTurn>>["turn"];
    try {
      const appended = await appendTurn({
        threadId: thread.id,
        role: "USER",
        content: input.message,
        actorUserId: userId,
        clientTurnId: input.clientTurnId ?? null,
        filePath: input.filePath ?? null,
        selection: input.selection ?? null
      });
      if (appended.duplicate) {
        if (gate.enforced) void gate.handle.done("stopped");
        return bail(json({ duplicate: true, turn: turnDto(appended.turn) }));
      }
      userTurn = appended.turn;
      assistantTurn = (
        await appendTurn({
          threadId: thread.id,
          role: "ASSISTANT",
          status: "streaming",
          actorUserId: null,
          model: config.model,
          promptVersion: ASK_PROMPT_VERSION,
          contextHash: context.hash,
          baseCommit: repo.commit
        })
      ).turn;
    } catch (error) {
      console.error("agent thread: could not store the turn", error instanceof Error ? error.message : "unknown error");
      if (gate.enforced) void gate.handle.done("error");
      return bail(problem(500, "The message could not be saved, so the assistant was not called.", "persist_failed"));
    }

    // Shadow: evaluated and recorded beside the turn, never awaited here, never changes the reply.
    // Enforced: the check already ran above; this only links the stored turns and finishes the work item.
    if (gate.enforced) await gate.link([userTurn.id, assistantTurn.id]);
    const control = gate.enforced
      ? gate.handle
      : openAssistantTurn({
          studyId,
          projectId,
          threadId: thread.id,
          userId,
          mode: "ask",
          clientTurnId: input.clientTurnId ?? userTurn.id,
          userText: input.message,
          selection: input.selection?.text ?? null,
          turnIds: [userTurn.id, assistantTurn.id]
        });

    let history: Awaited<ReturnType<typeof loadHistory>>;
    try {
      history = boundHistory(await loadHistory(thread.id, { beforeSeq: userTurn.seq }));
    // Agent threads keep their mode: it only says the code step follows an approved plan.
    if (thread.mode === "plan") await setThreadMode(thread.id, "ask").catch(() => undefined);

    await audit({
      actorUserId: userId,
      orgId: repo.project.study.orgId,
      studyId,
      action: "pipeline_project.agent_message",
      targetType: "PipelineProject",
      targetId: repo.project.id,
      metadata: {
        threadId: thread.id,
        userTurnId: userTurn.id,
        assistantTurnId: assistantTurn.id,
        contextHash: context.hash,
        commit: repo.commit,
        model: config.model,
        historyMessages: history.length,
        messageChars: input.message.length,
        filePath: input.filePath ?? null,
        hasSelection: Boolean(input.selection),
        truncated: context.truncated.length > 0,
        diagnosticsIncluded: loaded.diagnosticsIncluded
      },
      request
    });
    } catch (error) {
      console.error("agent thread: could not prepare the reply", error instanceof Error ? error.message : "unknown error");
      await finalizeTurn(assistantTurn.id, { status: "error" }).catch(() => undefined);
      void control.done("error", { model: config.model });
      return bail(problem(500, "The reply could not be prepared. Try again.", "persist_failed"));
    }


    const fail = async (message: string, code: string) => {
      await finalizeTurn(assistantTurn.id, { status: "error" }).catch(() => undefined);
      void control.done("error", { model: config.model });
      return bail(problem(502, message, code));
    };

    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          input: buildAgentInput({ context, history, message: input.message }),
          max_output_tokens: ASK_MAX_OUTPUT_TOKENS,
          store: false,
          stream: true
        }),
        signal: request.signal
      });
    } catch (error) {
      console.error("project-agent: upstream request failed", error instanceof Error ? error.message : "unknown error");
      return await fail("The assistant could not reach the model provider. Try again shortly.", "upstream_error");
    }
    if (!upstream.ok || !upstream.body) {
      const errorBody = (await upstream.json().catch(() => null)) as { error?: { message?: string } } | null;
      console.error("project-agent: upstream status", upstream.status, errorBody?.error?.message ?? upstream.statusText);
      return await fail("The model provider returned an error. Try again shortly.", "upstream_error");
    }

    const upstreamBody = upstream.body;
    const turnEvent: TurnEventData = { threadId: thread.id, userTurnId: userTurn.id, userSeq: userTurn.seq, assistantTurnId: assistantTurn.id, assistantSeq: assistantTurn.seq };
    let text = "";
    let finalized = false;
    const finish = async (status: "done" | "error" | "stopped") => {
      if (finalized) return;
      finalized = true;
      await finalizeTurn(assistantTurn.id, { status, content: text }).catch((error) => console.error("agent thread: finalize failed", error instanceof Error ? error.message : "unknown error"));
      void control.done(status, { model: config.model });
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const decoder = new TextDecoder();
        let completed = false;
        let failure: string | null = null;
        try {
          controller.enqueue(namedSse(THREAD_SSE_EVENTS.turn, turnEvent));
          controller.enqueue(sse({ type: "fedlify.context", hash: context.hash, commit: repo.commit, truncated: context.truncated, requirementsAnswered: context.pack.requirementsAnswered, requirementsTotal: context.pack.requirementsTotal }));
          const reader = upstreamBody.getReader();
          let buffer = "";
          const handle = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) return;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") return;
            try {
              const event = JSON.parse(data) as { type?: string; delta?: string; message?: string; error?: { message?: string }; response?: { error?: { message?: string }; incomplete_details?: { reason?: string } } };
              if (event.type !== "error" && event.type !== "response.failed") controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
              if (event.type === "response.output_text.delta" && typeof event.delta === "string" && text.length < LIMITS.turnContentChars) text += event.delta;
              if (event.type === "response.completed") completed = true;
              else if (event.type === "error") {
                console.error("project-agent: stream error event", event.message ?? event.error?.message ?? "unknown");
                failure = "The model provider reported an error.";
              } else if (event.type === "response.failed") {
                console.error("project-agent: response failed", event.response?.error?.message ?? "unknown");
                failure = "The model response failed.";
              } else if (event.type === "response.incomplete") {
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
        // The partial text is kept either way: a stop or an error still leaves what the person already read.
        await finish(failure ? (request.signal.aborted ? "stopped" : "error") : "done");
        release();
        try {
          if (failure) controller.enqueue(sse({ type: "fedlify.error", message: failure }));
          else controller.enqueue(sse({ type: "fedlify.done", contextHash: context.hash }));
          controller.close();
        } catch {
          // The client already disconnected.
        }
      },
      cancel() {
        void finish("stopped");
        release();
        upstreamBody.cancel().catch(() => undefined);
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  } catch (error) {
    release();
    throw error;
  }
}

// ---------- plan ----------

export type PlanTrigger =
  | { kind: "message"; message: string; clientTurnId?: string | null; filePath?: string | null; selection?: EditorSelection | null; diagnostics?: boolean }
  | { kind: "answers"; questionsTurnId: string; answers: Record<string, string | string[]>; skipped: boolean };

export type PlanTurnInput = {
  request: NextRequest;
  userId: string;
  studyId: string;
  projectId: string;
  thread: ThreadLike;
  config: AgentConfig;
  trigger: PlanTrigger;
  wantsSse: boolean;
};

type PlanTurnResult = {
  /** Null only when the turn was paused and the message was not stored. */
  userTurn: TurnDto | null;
  assistantTurn: TurnDto;
  questions?: QuestionsEventData;
  plan?: PlanEventData;
  refused?: boolean;
  /** Set when the control plane paused the turn (enforced studies only). */
  stopped?: true;
  stop?: StoredStop["stop"];
};

function planResponse(result: PlanTurnResult, wantsSse: boolean, status = 200): Response {
  if (!wantsSse) return json(result, { status });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!result.userTurn) {
        controller.enqueue(sse({ type: "fedlify.done", turnId: result.assistantTurn.id }));
        controller.close();
        return;
      }
      const turn: TurnEventData = {
        threadId: result.userTurn.threadId,
        userTurnId: result.userTurn.id,
        userSeq: result.userTurn.seq,
        assistantTurnId: result.assistantTurn.id,
        assistantSeq: result.assistantTurn.seq
      };
      controller.enqueue(namedSse(THREAD_SSE_EVENTS.turn, turn));
      if (result.questions) controller.enqueue(namedSse(THREAD_SSE_EVENTS.questions, result.questions));
      if (result.plan) controller.enqueue(namedSse(THREAD_SSE_EVENTS.plan, result.plan));
      controller.enqueue(sse({ type: "fedlify.done", turnId: result.assistantTurn.id }));
      controller.close();
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

/** Turns that drive the question rounds: questions, answers and plans of this thread. */
async function loadQaTurns(threadId: string) {
  return prisma.agentTurn.findMany({ where: { threadId, kind: { in: ["QUESTIONS", "ANSWERS", "PLAN"] } }, orderBy: { seq: "asc" }, select: { id: true, seq: true, kind: true, payload: true } });
}

/** One structured planning call: ASK (questions), PLAN (a draft plan) or REFUSE. Never writes code or files. */
export async function runPlanTurn(input: PlanTurnInput): Promise<Response> {
  const { request, userId, studyId, projectId, thread, config, trigger } = input;
  const clientTurnId = trigger.kind === "message" ? (trigger.clientTurnId ?? null) : `answers:${trigger.questionsTurnId}`;
  const duplicate = await existingTurn(thread.id, clientTurnId);
  if (duplicate) return json({ duplicate: true, turn: turnDto(duplicate) });

  if (!rateLimit(`project-agent-plan:${userId}`, 8, 60_000) || !rateLimit(`project-agent-plan-project:${projectId}`, 30, 60_000)) {
    return problem(429, "Too many planning requests. Wait a minute and try again.", "rate_limited");
  }
  const release = acquireSlot(`project-agent-plans:${userId}`, 1);
  if (!release) return problem(429, "A plan is already being written. Wait for it to finish.", "rate_limited");
  let control: ReturnType<typeof openAssistantTurn> = { done: async () => undefined };
  try {
    // The original request: the message itself, or the last user message when answering questions.
    let message: string;
    if (trigger.kind === "message") message = trigger.message;
    else {
      const last = await prisma.agentTurn.findFirst({ where: { threadId: thread.id, role: "USER", kind: "MESSAGE" }, orderBy: { seq: "desc" } });
      message = last?.content ?? "Plan the requested change.";
    }

    const loaded = await loadTurnContext({
      userId,
      studyId,
      projectId,
      message,
      filePath: trigger.kind === "message" ? trigger.filePath : null,
      selectionText: trigger.kind === "message" ? trigger.selection?.text : null,
      diagnostics: trigger.kind === "message" ? trigger.diagnostics : false
    });
    if (!loaded.ok) return loaded.response;
    const { repo, context, responses } = loaded;
    if (!repo.commit) return problem(409, "There is no saved commit to plan a change against.", "no_commit");
    const baseCommit = repo.commit;
    const orgId = repo.project.study.orgId;

    // Enforced studies only (a no-op otherwise): the safety check finishes BEFORE anything is stored or any model is called.
    const gate = await guardAssistantTurn({
      studyId,
      projectId,
      threadId: thread.id,
      userId,
      mode: trigger.kind === "answers" ? "answers" : "plan",
      clientTurnId: clientTurnId ?? randomUUID(),
      userText: trigger.kind === "message" ? trigger.message : "",
      selection: trigger.kind === "message" ? (trigger.selection?.text ?? null) : null,
      answers: trigger.kind === "answers" ? trigger.answers : null
    });
    if (gate.enforced && gate.blocked) {
      try {
        // Answers are not stored as a turn, so the questions stay open and can be answered again.
        const stored = await storeStop({ gate, request, userId, orgId, studyId, projectId, threadId: thread.id, userTurn: trigger.kind === "message" ? { clientTurnId } : null, contextHash: context.hash, baseCommit });
        if (!input.wantsSse) return json({ userTurn: stored.userTurn, assistantTurn: stored.noticeTurn, stopped: true, stop: stored.stop } satisfies PlanTurnResult);
        return stopStream(stored);
      } catch (error) {
        console.error("agent thread: could not store the stop notice", error instanceof Error ? error.message : "unknown error");
        return problem(503, gate.stop.why, "assistant_stopped");
      }
    }
    if (gate.enforced) control = gate.handle;

    // Store what the person sent before calling the model.
    let userTurn: Awaited<ReturnType<typeof appendTurn>>["turn"];
    try {
      const appended =
        trigger.kind === "message"
          ? await appendTurn({
              threadId: thread.id,
              role: "USER",
              content: trigger.message,
              actorUserId: userId,
              clientTurnId,
              filePath: trigger.filePath ?? null,
              selection: trigger.selection ?? null
            })
          : await appendTurn({
              threadId: thread.id,
              role: "USER",
              kind: "ANSWERS",
              actorUserId: userId,
              clientTurnId,
              payload: { questionsTurnId: trigger.questionsTurnId, answers: trigger.answers, ...(trigger.skipped ? { skipped: true } : {}) }
            });
      if (appended.duplicate) return json({ duplicate: true, turn: turnDto(appended.turn) });
      userTurn = appended.turn;
    } catch (error) {
      console.error("agent thread: could not store the turn", error instanceof Error ? error.message : "unknown error");
      return problem(500, "The message could not be saved, so the assistant was not called.", "persist_failed");
    }
    if (thread.mode === "ask") await setThreadMode(thread.id, "plan").catch(() => undefined);

    // Shadow (see runAskTurn). The safety net in `finally` records "error" if no path below did.
    if (gate.enforced) await gate.link([userTurn.id]);
    else {
      control = openAssistantTurn({
        studyId,
        projectId,
        threadId: thread.id,
        userId,
        mode: trigger.kind === "answers" ? "answers" : "plan",
        clientTurnId: clientTurnId ?? userTurn.id,
        userText: trigger.kind === "message" ? trigger.message : "",
        selection: trigger.kind === "message" ? (trigger.selection?.text ?? null) : null,
        answers: trigger.kind === "answers" ? trigger.answers : null,
        turnIds: [userTurn.id]
      });
    }
    const finishControl = (outcome: AssistantOutcome, assistantTurnId?: string) => void control.done(outcome, { model: config.model, turnIds: assistantTurnId ? [assistantTurnId] : [] });

    const state = questionState(await loadQaTurns(thread.id));
    const history = boundHistory(await loadHistory(thread.id, { beforeSeq: userTurn.seq }));
    const reqHash = requirementsHash(responses);
    const userDto = turnDto(userTurn);

    /** A failed plan call still leaves a NOTICE turn and an audit entry, and no plan. */
    const notice = async (text: string, code: string, status: number) => {
      // Failed answers are not kept, so the questions reopen and the same answers can be sent again.
      if (trigger.kind === "answers") await prisma.agentTurn.delete({ where: { id: userTurn.id } }).catch(() => undefined);
      const turn = await appendTurn({ threadId: thread.id, role: "ASSISTANT", kind: "NOTICE", content: text, status: "error", model: config.model, promptVersion: PLAN_PROMPT_VERSION, contextHash: context.hash, baseCommit }).catch(() => null);
      await audit({
        actorUserId: userId,
        orgId,
        studyId,
        action: AGENT_PLAN_INVALID_ACTION,
        targetType: "PipelineProject",
        targetId: projectId,
        metadata: { threadId: thread.id, userTurnId: userTurn.id, assistantTurnId: turn?.turn.id ?? null, code, model: config.model, contextHash: context.hash },
        request
      }).catch(() => undefined);
      finishControl("error", turn?.turn.id);
      return problem(status, text, code);
    };

    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          input: buildPlanInput({ context, history, message, qa: state.qa, blank: blankRequirements(responses), forcePlan: state.forcePlan }),
          max_output_tokens: PLAN_MAX_OUTPUT_TOKENS,
          store: false,
          text: { format: { type: "json_schema", name: "fedlify_change_plan", strict: true, schema: PLAN_JSON_SCHEMA } }
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)])
      });
    } catch (error) {
      console.error("project-agent-plan: upstream request failed", error instanceof Error ? error.message : "unknown error");
      return notice("The assistant could not reach the model provider. Try again shortly.", "upstream_error", 502);
    }
    const upstreamBody = (await upstream.json().catch(() => null)) as unknown;
    if (!upstream.ok) {
      console.error("project-agent-plan: upstream status", upstream.status, (upstreamBody as { error?: { message?: string } } | null)?.error?.message ?? upstream.statusText);
      return notice("The model provider returned an error. Try again shortly.", "upstream_error", 502);
    }

    const parsed = parsePlanResponse(upstreamBody);
    if (!parsed.ok) return notice(parsed.message, "plan_unreadable", 502);
    const result: NormalizedPlanResult = parsed.result;

    if (result.disposition === "ASK") {
      if (state.forcePlan) return notice("The assistant kept asking questions after the limit. Try again with more detail.", "plan_unreadable", 502);
      if (result.questions.length === 0) return notice("The assistant asked for input without a question.", "plan_unreadable", 502);
      const payload: QuestionsPayload = { round: state.rounds + 1, questions: result.questions };
      const assistant = await appendTurn({ threadId: thread.id, role: "ASSISTANT", kind: "QUESTIONS", content: result.rationale, payload, model: config.model, promptVersion: PLAN_PROMPT_VERSION, contextHash: context.hash, baseCommit });
      await audit({
        actorUserId: userId,
        orgId,
        studyId,
        action: AUDIT_ACTIONS.planQuestions,
        targetType: "PipelineProject",
        targetId: projectId,
        metadata: { threadId: thread.id, turnId: assistant.turn.id, round: payload.round, questionCount: payload.questions.length, contextHash: context.hash },
        request
      });
      const assistantDto = turnDto(assistant.turn);
      finishControl("done", assistant.turn.id);
      return planResponse({ userTurn: userDto, assistantTurn: assistantDto, questions: { threadId: thread.id, turnId: assistantDto.id, seq: assistantDto.seq, payload } }, input.wantsSse);
    }

    if (result.disposition === "REFUSE" || result.plan.steps.length === 0) {
      const text = result.rationale || "The assistant did not propose a plan for this request.";
      const assistant = await appendTurn({ threadId: thread.id, role: "ASSISTANT", content: text, model: config.model, promptVersion: PLAN_PROMPT_VERSION, contextHash: context.hash, baseCommit });
      finishControl("refused", assistant.turn.id);
      return planResponse({ userTurn: userDto, assistantTurn: turnDto(assistant.turn), refused: true }, input.wantsSse);
    }

    // Enforced studies only: an approved plan that this one replaces no longer stands behind its approval.
    let replaced: Array<{ id: string; approvalBindingId: string | null }> = [];
    if (gate.enforced) {
      try {
        replaced = await prisma.agentPlan.findMany({ where: { threadId: thread.id, status: "APPROVED", approvalBindingId: { not: null } }, select: { id: true, approvalBindingId: true } });
      } catch {
        replaced = [];
      }
    }
    const plan = await createPlan({
      threadId: thread.id,
      summary: result.plan.summary || result.rationale.slice(0, 500) || "Plan",
      steps: result.plan.steps,
      assumptions: result.plan.assumptions,
      baseCommit,
      contextHash: context.hash,
      requirementsHash: reqHash
    });
    let assistant: Awaited<ReturnType<typeof appendTurn>>;
    try {
      assistant = await appendTurn({ threadId: thread.id, role: "ASSISTANT", kind: "PLAN", content: result.rationale, payload: { planId: plan.id }, planId: plan.id, model: config.model, promptVersion: PLAN_PROMPT_VERSION, contextHash: context.hash, baseCommit });
    } catch (error) {
      // A plan with no turn would be invisible in the thread: mark it replaced rather than leave an orphan draft.
      await prisma.agentPlan.updateMany({ where: { id: plan.id, status: "DRAFT" }, data: { status: "SUPERSEDED" } }).catch(() => undefined);
      console.error("agent thread: could not store the plan turn", error instanceof Error ? error.message : "unknown error");
      return problem(500, "The plan could not be saved.", "persist_failed");
    }
    await linkTurn(assistant.turn.id, { planId: plan.id }).catch(() => undefined);
    // Enforced studies only: the plan's artifact revision and its rule-based verification run.
    if (gate.enforced) {
      await recordPlanControl(plan, { studyId, userId, workItemId: gate.workItemId });
      for (const old of replaced) await invalidateApprovalBinding({ studyId, approvalBindingId: old.approvalBindingId, reason: "A newer plan replaced the approved one.", source: { type: "AgentPlan", id: plan.id, hash: plan.id } });
    }
    await audit({
      actorUserId: userId,
      orgId,
      studyId,
      action: AUDIT_ACTIONS.plan,
      targetType: "PipelineProject",
      targetId: projectId,
      metadata: {
        threadId: thread.id,
        planId: plan.id,
        version: plan.version,
        stepCount: result.plan.steps.length,
        droppedSteps: result.plan.droppedSteps,
        stepsHash: sha256(JSON.stringify(result.plan.steps.map((step) => [step.id, step.paths, step.action]))),
        baseCommit,
        contextHash: context.hash,
        requirementsHash: reqHash,
        model: config.model
      },
      request
    });
    const assistantDto = turnDto(assistant.turn);
    finishControl("done", assistant.turn.id);
    return planResponse({ userTurn: userDto, assistantTurn: assistantDto, plan: { threadId: thread.id, turnId: assistantDto.id, seq: assistantDto.seq, plan: planDto(plan) } }, input.wantsSse, 201);
  } finally {
    // No-op when an outcome was already recorded; covers the paths that return a problem or throw.
    void control.done("error", { model: config.model });
    release();
  }
}

export function isTurnMode(value: string): value is TurnMode {
  return value === "ask" || value === "plan";
}
