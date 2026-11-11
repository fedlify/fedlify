/**
 * Browser-side calls and pure view helpers for agent threads (history, plan mode, changes timeline).
 * The server is the source of truth: the panel hydrates from these responses after every action.
 * Nothing here writes code; plan approval is recorded intent and the diff is still accepted separately.
 */
import type { CommitDiff } from "@/lib/agent-timeline";
import type { AssistantEvent } from "@/lib/assistant-stream";
import { isWithheldNote, stopFromPayload } from "@/lib/assistant-control-client";
import type { StopPayload } from "@/lib/terms";
import {
  THREAD_ERROR_CODES,
  type AnswersBody,
  type PlanAssumption,
  type PlanDecisionBody,
  type PlanDto,
  type PlanQuestion,
  type PlanStatus,
  type PlanStep,
  type QuestionsPayload,
  type AnswersPayload,
  type SendTurnBody,
  type ThreadDetailDto,
  type ThreadMetadataDto,
  type ThreadMode,
  type ThreadPhase,
  type ThreadProposalDto,
  type ThreadSummaryDto,
  type TimelinePageDto,
  type TimelineKind,
  type TurnDto
} from "@/lib/agent-thread-types";

export type ThreadFailure = { ok: false; status: number; code: string; message: string; details: string[] };
export type ThreadResult<T> = ({ ok: true } & T) | ThreadFailure;

/** Shown in the panel and the history popover. Matches the retention decision: kept until the project is deleted. */
export const RETENTION_NOTICE = "Chats are saved with the project and kept until the project is deleted. Archive a chat to hide it from the list.";

function base(studyId: string, projectId: string) {
  return `/api/v1/studies/${studyId}/pipeline-projects/${projectId}/agent`;
}

export function failureFrom(status: number, body: unknown): ThreadFailure {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  return {
    ok: false,
    status,
    code: typeof error?.code === "string" ? error.code : "error",
    message: typeof error?.message === "string" ? error.message : `Request failed (${status}).`,
    details: Array.isArray(error?.details) ? error.details.filter((item): item is string => typeof item === "string") : []
  };
}

async function call<T>(url: string, init?: RequestInit, signal?: AbortSignal): Promise<ThreadResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init, signal, headers: { "content-type": "application/json", ...init?.headers } });
    const body = await response.json().catch(() => null);
    if (!response.ok) return failureFrom(response.status, body);
    return { ok: true, ...((body ?? {}) as T) };
  } catch {
    return { ok: false, status: 0, code: "network", message: signal?.aborted ? "Cancelled." : "The request could not be completed.", details: [] };
  }
}

export const listThreads = (studyId: string, projectId: string, options: { cursor?: string | null; q?: string; status?: "ACTIVE" | "ARCHIVED"; scope?: "own" | "all" } = {}) => {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.status) params.set("status", options.status);
  if (options.scope) params.set("scope", options.scope);
  const query = params.toString();
  return call<{ threads: ThreadSummaryDto[]; nextCursor: string | null }>(`${base(studyId, projectId)}/threads${query ? `?${query}` : ""}`);
};
export const createThread = (studyId: string, projectId: string, body: { message?: string; mode?: ThreadMode }) =>
  call<{ thread: ThreadSummaryDto }>(`${base(studyId, projectId)}/threads`, { method: "POST", body: JSON.stringify(body) });
export const getThread = (studyId: string, projectId: string, threadId: string, after?: number) =>
  call<Partial<ThreadDetailDto> & Partial<ThreadMetadataDto> & { thread: ThreadSummaryDto }>(
    `${base(studyId, projectId)}/threads/${threadId}${after ? `?after=${after}` : ""}`
  );
/** The whole thread: follows `hasMore` page by page so threads over one page keep showing new turns. */
export async function getThreadAll(studyId: string, projectId: string, threadId: string) {
  const first = await getThread(studyId, projectId, threadId);
  if (!first.ok) return first;
  let merged = first;
  for (let page = 0; page < 30 && merged.hasMore && merged.turns?.length; page += 1) {
    const next = await getThread(studyId, projectId, threadId, Math.max(...merged.turns.map((turn) => turn.seq)));
    if (!next.ok) break;
    merged = { ...next, turns: mergeTurns(merged.turns, next.turns ?? []) };
  }
  return merged;
}
export const patchThread = (studyId: string, projectId: string, threadId: string, body: { title?: string; status?: "ACTIVE" | "ARCHIVED" }) =>
  call<{ ok: boolean }>(`${base(studyId, projectId)}/threads/${threadId}`, { method: "PATCH", body: JSON.stringify(body) });
export const submitAnswers = (studyId: string, projectId: string, threadId: string, body: AnswersBody) =>
  call<Record<string, unknown>>(`${base(studyId, projectId)}/threads/${threadId}/answers`, { method: "POST", body: JSON.stringify(body) });
export const decidePlan = (studyId: string, projectId: string, threadId: string, planId: string, body: PlanDecisionBody) =>
  call<Record<string, unknown>>(`${base(studyId, projectId)}/threads/${threadId}/plans/${planId}/decision`, { method: "POST", body: JSON.stringify(body) });
/** The AI second check for a plan. Idempotent on the server; `retry` runs it again. */
export const verifyPlan = (studyId: string, projectId: string, threadId: string, planId: string, retry = false) =>
  call<{ verification?: unknown }>(`${base(studyId, projectId)}/threads/${threadId}/plans/${planId}/verify${retry ? "?retry=1" : ""}`, { method: "POST", body: "{}" });
export const codeFromPlan = (studyId: string, projectId: string, threadId: string, planId: string, signal?: AbortSignal) =>
  call<Record<string, unknown>>(`${base(studyId, projectId)}/threads/${threadId}/plans/${planId}/code`, { method: "POST", body: "{}" }, signal);
export const turnsUrl = (studyId: string, projectId: string, threadId: string) => `${base(studyId, projectId)}/threads/${threadId}/turns`;
export const getCommitDiff = (studyId: string, projectId: string, commit: string) =>
  call<CommitDiff>(`${base(studyId, projectId)}/timeline?commit=${encodeURIComponent(commit)}`);
export const getTimeline = (studyId: string, projectId: string, options: { cursor?: string | null; kind?: TimelineKind } = {}) => {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.kind) params.set("kind", options.kind);
  const query = params.toString();
  return call<TimelinePageDto>(`${base(studyId, projectId)}/timeline${query ? `?${query}` : ""}`);
};

export function newClientTurnId(): string {
  const c = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  return c?.randomUUID ? c.randomUUID() : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Thread mode only maps ask and plan to turns; "agent" runs the plan turn then waits for approval. "edit" is the old direct path. */
export type PanelMode = "ask" | "plan" | "agent" | "edit";
export function turnModeFor(mode: PanelMode): SendTurnBody["mode"] | null {
  if (mode === "ask") return "ask";
  if (mode === "plan" || mode === "agent") return "plan";
  return null;
}
export function threadModeFor(mode: PanelMode): ThreadMode {
  return mode === "edit" ? "ask" : mode;
}

/** The threads feature is off (or unavailable) when the list call fails like this; the panel then behaves as it did before. */
export function threadsUnavailable(failure: ThreadFailure): boolean {
  return failure.code === THREAD_ERROR_CODES.disabled || failure.status === 404 || failure.status === 403 || failure.status === 501;
}

// ---------- detail normalisation ----------

export type ThreadView = {
  thread: ThreadSummaryDto;
  readOnly: boolean;
  canDecidePlan: boolean;
  canArchive: boolean;
  metadataOnly: boolean;
  turns: TurnDto[];
  plans: PlanDto[];
  proposals: ThreadProposalDto[];
  phase: ThreadPhase;
  hasMore: boolean;
  /** "enforce" when the study enforces the control plane; absent otherwise. */
  controlMode?: "enforce";
};

export function toThreadView(body: Partial<ThreadDetailDto> & Partial<ThreadMetadataDto> & { thread: ThreadSummaryDto }): ThreadView {
  const metadataOnly = body.metadataOnly === true;
  const access = body.access ?? { level: "author" as const, readOnly: false, canDecidePlan: true, canArchive: true };
  return {
    thread: body.thread,
    readOnly: metadataOnly || access.readOnly,
    canDecidePlan: !metadataOnly && access.canDecidePlan && !access.readOnly,
    canArchive: access.canArchive,
    metadataOnly,
    turns: metadataOnly ? [] : [...(body.turns ?? [])].sort((a, b) => a.seq - b.seq),
    plans: metadataOnly ? [] : body.plans ?? [],
    proposals: metadataOnly ? [] : body.proposals ?? [],
    phase: body.phase ?? "CHATTING",
    hasMore: Boolean(body.hasMore),
    ...(body.controlMode === "enforce" ? { controlMode: "enforce" as const } : {})
  };
}

/** Merge newly fetched turns into the ones held, by id (incoming wins), ordered by seq. */
export function mergeTurns(existing: TurnDto[], incoming: TurnDto[]): TurnDto[] {
  const byId = new Map(existing.map((turn) => [turn.id, turn]));
  for (const turn of incoming) byId.set(turn.id, turn);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function lastSeq(turns: TurnDto[]): number {
  return turns.reduce((max, turn) => Math.max(max, turn.seq), 0);
}

/** True when the thread holds a user message with this text stored after `seqBefore`. */
export function storedUserTurn(view: { turns: TurnDto[] } | null, text: string, seqBefore: number): boolean {
  return Boolean(view?.turns.some((turn) => turn.role === "USER" && turn.kind === "MESSAGE" && turn.seq > seqBefore && turn.content.trim() === text.trim()));
}

// ---------- chat items (hydration) ----------

export type ChatItem =
  | { type: "message"; key: string; role: "user" | "assistant"; content: string; status: TurnDto["status"]; isNotice: boolean; turnId: string; /** The message was withheld by the safety check; only a short note is stored. */ withheld?: true }
  | { type: "stop"; key: string; turnId: string; stop: StopPayload }
  | { type: "questions"; key: string; turnId: string; payload: QuestionsPayload; answered: AnswersPayload | null }
  | { type: "plan"; key: string; planId: string; turnId: string }
  | { type: "proposal"; key: string; proposalId: string; turnId: string }
  | { type: "steps"; key: string; steps: { id: string; label: string }[] };

function payloadOf(turn: TurnDto): Record<string, unknown> {
  const value: unknown = turn.payload;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stepLabel(turn: TurnDto, plans: PlanDto[]): string {
  if (turn.kind === "ANSWERS") return (turn.payload as AnswersPayload | null)?.skipped ? "Skipped the questions" : "Answered the questions";
  if (turn.kind === "PLAN_DECISION") {
    const payload = payloadOf(turn);
    const plan = plans.find((item) => item.id === payload.planId);
    const label = plan ? `Plan v${plan.version}` : "Plan";
    return payload.decision === "approve" ? `${label} approved` : `${label} rejected`;
  }
  return turn.kind.toLowerCase();
}

/** Turn rows to render rows. Answers and plan decisions fold into one collapsible "steps" group; answers attach to their questions. */
export function buildChatItems(turns: TurnDto[], plans: PlanDto[]): ChatItem[] {
  const answers = new Map<string, AnswersPayload>();
  for (const turn of turns) {
    const qid = payloadOf(turn).questionsTurnId;
    if (turn.kind === "ANSWERS" && typeof qid === "string") answers.set(qid, turn.payload as unknown as AnswersPayload);
  }
  const items: ChatItem[] = [];
  for (const turn of turns) {
    const role = turn.role === "USER" ? "user" : "assistant";
    switch (turn.kind) {
      case "MESSAGE":
      case "NOTICE": {
        const stop = turn.kind === "NOTICE" ? stopFromPayload(turn.payload) : null;
        if (stop) {
          items.push({ type: "stop", key: turn.id, turnId: turn.id, stop });
          break;
        }
        items.push({
          type: "message", key: turn.id, role, content: turn.content, status: turn.status, isNotice: turn.kind === "NOTICE", turnId: turn.id,
          ...(role === "user" && isWithheldNote(turn.content) ? { withheld: true as const } : {})
        });
        break;
      }
      case "QUESTIONS":
        if (Array.isArray(payloadOf(turn).questions)) items.push({ type: "questions", key: turn.id, turnId: turn.id, payload: turn.payload as unknown as QuestionsPayload, answered: answers.get(turn.id) ?? null });
        break;
      case "PLAN": {
        const rawPlanId = payloadOf(turn).planId;
        const planId = turn.planId ?? (typeof rawPlanId === "string" ? rawPlanId : null);
        if (planId) items.push({ type: "plan", key: turn.id, planId, turnId: turn.id });
        break;
      }
      case "PROPOSAL": {
        const rawProposalId = payloadOf(turn).proposalId;
        const proposalId = turn.proposalId ?? (typeof rawProposalId === "string" ? rawProposalId : null);
        if (proposalId) items.push({ type: "proposal", key: turn.id, proposalId, turnId: turn.id });
        break;
      }
      case "ANSWERS":
      case "PLAN_DECISION": {
        const last = items[items.length - 1];
        const step = { id: turn.id, label: stepLabel(turn, plans) };
        if (last?.type === "steps") last.steps.push(step);
        else items.push({ type: "steps", key: `steps-${turn.id}`, steps: [step] });
        break;
      }
    }
  }
  return items;
}

// ---------- streaming reducer ----------

export type StreamState = {
  /** Set when the control plane paused the assistant. */
  stop?: StopPayload;
  content: string;
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
  notice?: string;
  assistantTurnId?: string;
  userTurnId?: string;
  /** Set when the stream announced questions or a plan: the panel then refreshes the thread to show the card. */
  structured: boolean;
};

export const initialStream = (): StreamState => ({ content: "", status: "streaming", structured: false });

export function reduceStream(state: StreamState, event: AssistantEvent): StreamState {
  switch (event.kind) {
    case "delta":
      return { ...state, content: state.content + event.text };
    case "notice":
      return { ...state, notice: event.message };
    case "error":
      return { ...state, status: "error", error: event.message };
    case "done":
      return state.status === "streaming" ? { ...state, status: "done" } : state;
    case "turn":
      return { ...state, assistantTurnId: event.data.assistantTurnId, userTurnId: event.data.userTurnId };
    case "stop":
      return { ...state, stop: event.data.stop, content: state.content || event.data.stop.title, assistantTurnId: event.data.turnId, userTurnId: event.data.userTurnId ?? state.userTurnId, status: "done" };
    case "questions":
    case "plan":
      return { ...state, structured: true };
    default:
      return state;
  }
}

// ---------- questions card ----------

export type AnswerDraft = Record<string, { selected: string[]; other: string }>;

/** Recommended options start selected. */
export function initialDraft(questions: PlanQuestion[]): AnswerDraft {
  return Object.fromEntries(questions.map((q) => [q.id, { selected: q.options.filter((o) => o.recommended).map((o) => o.id).slice(0, q.multi ? q.options.length : 1), other: "" }]));
}

export function selectOption(draft: AnswerDraft, question: PlanQuestion, optionId: string): AnswerDraft {
  const current = draft[question.id] ?? { selected: [], other: "" };
  if (question.multi) {
    const selected = current.selected.includes(optionId) ? current.selected.filter((id) => id !== optionId) : [...current.selected, optionId];
    return { ...draft, [question.id]: { ...current, selected } };
  }
  // Picking a listed option in a single-choice question clears any typed "Other".
  return { ...draft, [question.id]: { selected: [optionId], other: "" } };
}

export function setOther(draft: AnswerDraft, question: PlanQuestion, text: string): AnswerDraft {
  const current = draft[question.id] ?? { selected: [], other: "" };
  // Typing a custom answer in a single-choice question replaces the selected option.
  return { ...draft, [question.id]: { selected: question.multi ? current.selected : text.trim() ? [] : current.selected, other: text } };
}

export function isAnswered(question: PlanQuestion, draft: AnswerDraft): boolean {
  const entry = draft[question.id];
  return Boolean(entry && (entry.selected.length > 0 || (question.allowOther && entry.other.trim())));
}

export const canSubmitAnswers = (questions: PlanQuestion[], draft: AnswerDraft) => questions.length > 0 && questions.every((q) => isAnswered(q, draft));

export function toAnswers(questions: PlanQuestion[], draft: AnswerDraft): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const question of questions) {
    const entry = draft[question.id];
    if (!entry) continue;
    const other = question.allowOther ? entry.other.trim() : "";
    if (question.multi) {
      const values = other ? [...entry.selected, other] : entry.selected;
      if (values.length) out[question.id] = values;
    } else {
      const value = other || entry.selected[0];
      if (value) out[question.id] = value;
    }
  }
  return out;
}

// ---------- plan card ----------

export function initialApprovedSteps(plan: Pick<PlanDto, "steps" | "approvedStepIds">): string[] {
  return plan.approvedStepIds ?? plan.steps.filter((step) => step.enabled).map((step) => step.id);
}

export function toggleStep(selected: string[], stepId: string): string[] {
  return selected.includes(stepId) ? selected.filter((id) => id !== stepId) : [...selected, stepId];
}

export function assumptionsNeedingAck(assumptions: PlanAssumption[], acked: string[]): PlanAssumption[] {
  return assumptions.filter((item) => item.needsAck && !acked.includes(item.id));
}

export function canApprovePlan(plan: Pick<PlanDto, "status" | "assumptions">, selected: string[], acked: string[]): boolean {
  return plan.status === "DRAFT" && selected.length > 0 && assumptionsNeedingAck(plan.assumptions, acked).length === 0;
}

/** A draft or approved plan written against a commit that is no longer the saved head reads as stale right away. */
export function effectivePlanStatus(plan: Pick<PlanDto, "status" | "baseCommit">, head: string | null): PlanStatus {
  if ((plan.status === "DRAFT" || plan.status === "APPROVED") && head && plan.baseCommit && plan.baseCommit !== head) return "STALE";
  return plan.status;
}

/** Steps marked high risk, called out on the plan card. */
export function highRiskSteps(steps: PlanStep[]): PlanStep[] {
  return steps.filter((step) => step.risk === "high");
}

export function latestPlan(plans: PlanDto[]): PlanDto | null {
  return plans.reduce<PlanDto | null>((best, plan) => (!best || plan.version > best.version ? plan : best), null);
}

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  DRAFT: "Plan draft",
  APPROVED: "Plan approved",
  REJECTED: "Plan rejected",
  SUPERSEDED: "Superseded",
  STALE: "Plan stale",
  EXECUTED: "Code written"
};

export const PHASE_LABEL: Record<ThreadPhase, string> = {
  CHATTING: "Chatting",
  TRIAGE: "Planning",
  NEEDS_INPUT: "Needs your input",
  PLAN_DRAFT: "Plan draft",
  PLAN_APPROVED: "Plan approved",
  PROPOSED: "Change proposed",
  ACCEPTED: "Change accepted",
  REJECTED: "Change rejected",
  STALE: "Plan stale"
};

// ---------- thread selection / URL ----------

export const lastThreadKey = (projectId: string) => `fedlify.assistant.thread:${projectId}`;

/** URL id wins over the stored one; an archived or unknown id is not restored by the caller. */
export function pickInitialThread(urlId: string | null, storedId: string | null): string | null {
  return urlId?.trim() || storedId?.trim() || null;
}

/** New query string with `thread` set or removed; other params untouched. */
export function withThreadParam(search: string, threadId: string | null): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  if (threadId) params.set("thread", threadId);
  else params.delete("thread");
  const out = params.toString();
  return out ? `?${out}` : "";
}

export function threadRowSubtitle(thread: ThreadSummaryDto): string {
  const parts: string[] = [];
  if (thread.planStatus) parts.push(PLAN_STATUS_LABEL[thread.planStatus]);
  if (thread.proposalCount > 0) parts.push(`${thread.proposalCount} change${thread.proposalCount === 1 ? "" : "s"}`);
  return parts.join(" - ");
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
