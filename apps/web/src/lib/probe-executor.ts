/**
 * Probe executor: drives ONE probe through the real assistant path of an enforced study and reports what happened in
 * the observation shape that evaluation/probes/run_probes.py scores (disposition, blockingLayer, stopCondition,
 * stateTransition, prohibitedPropagation, infrastructureFailure, executionMode).
 *
 * It calls the same runners the product uses (runPlanTurn, runProposal, runAskTurn), so the safety check
 * (guardAssistantTurn) runs inside them exactly as for a person. It never accepts a proposal and never writes code.
 * The route in app/api/v1/studies/[studyId]/probe-executor/route.ts only does authentication and wiring.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { assistantEnforceStudies } from "@/lib/runtime-config";
import { createSseParser } from "@/lib/assistant-stream";
import type { StopPayload } from "@/lib/terms";

export const PROBE_EXECUTION_MODE = "LIVE_E2E_ASSISTANT";
export const PROBE_MESSAGE_LIMIT = 8000;

export const probeRequestSchema = z.object({
  probeId: z.string().trim().min(1).max(60),
  category: z.string().max(200).optional(),
  actor: z.string().max(200).optional(),
  studyContext: z.string().max(4000).optional(),
  prompt: z.string().min(1).max(60_000),
  fixture: z.object({ name: z.string().max(300), sha256: z.string().max(100).optional(), content: z.string().max(200_000) }).optional(),
  profile: z.string().max(60).optional(),
  repetition: z.number().int().min(1).max(100).optional(),
  isolationKey: z.string().trim().min(1).max(200),
  /** The pipeline project the throwaway thread lives in. */
  projectId: z.string().trim().min(1).max(100),
  /** Groups the probes of one run. Part of every client turn id so a rerun with a new id never hits the idempotency key. */
  runId: z.string().trim().min(1).max(100),
  /** plan: structured planning turn (default). proposal: stateless change proposal. ask: conversational reply. */
  assistantMode: z.enum(["plan", "proposal", "ask"]).default("plan")
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export type ProbeObservation = {
  probeId: string;
  executionMode: typeof PROBE_EXECUTION_MODE;
  assistantMode: ProbeRequest["assistantMode"];
  /** Vocabulary of the probe suite (IntakeResolution). */
  disposition: string;
  /** What the assistant itself returned: STOP, QUESTIONS, PLAN, PROPOSE, ANSWER, REFUSED, ERROR. */
  assistantOutcome: string;
  blockingLayer: string;
  stopCondition: string;
  stateTransition: string;
  prohibitedPropagation: string[];
  infrastructureFailure: boolean;
  stopCode?: string;
  stopCodes?: string[];
  workItemId?: string | null;
  workItemStatus?: string | null;
  controlState?: string | null;
  threadId?: string;
  proposalId?: string;
  planId?: string;
  errorCode?: string;
  /** True when the assistant (not the control layer) declined or proposed nothing. Scored as MODEL_DECLINED, never as a policy block. */
  refusedBy?: "assistant";
  /** The control plane's own stop code (STOP_1_INTAKE, STOP_5_POLICY) for the work item; stopCondition is the probe suite's number. */
  platformStopCondition?: string | null;
  /** The message was cut to the product's message limit: the probe did not see its whole fixture and is not comparable. */
  truncated?: boolean;
  originalLength?: number;
  /** What answered: build, model route, control mode and policy version of the pod that ran the probe. */
  runtime?: ProbeRuntime;
  /** True when a rate limit stopped the call: the runner should wait and repeat the probe. */
  rateLimited?: boolean;
  model?: string;
};

/** Reason codes that come from the intake classifier (see guardAssistantTurn). */
export type ProbeRuntime = { buildId: string; modelRoute: string; controlMode: string; policyVersion: string };

export const INTAKE_STOP_CODES = new Set(["SENSITIVE_CONTENT", "RAW_CLINICAL_DATA", "ACTIVE_CONTENT", "PROMPT_INJECTION", "MODEL_UPDATE_ARTIFACT"]);

const LAYER_INTAKE = "Intake classifier";
const LAYER_POLICY = "Policy engine / work-item contract";
const LAYER_DETERMINISTIC = "Deterministic verifier";
const LAYER_NONE = "No block - proceed";
const LAYER_MODEL = "Model (advisory)";
/** Work item states that are final: a probe is only scored once its work item is in one of them. */
const FINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"]);
/** Observed stop numbers in the vocabulary of the probe suite. Quarantine is 4 there; the platform's own code is kept apart. */
const SUITE_STOP_QUARANTINE = "4";
const SUITE_STOP_DETERMINISTIC = "6";
const STOP_UNMAPPED = "unmapped";

type WorkItemView = { id: string; status: string | null; controlState: string | null; stopCondition: string | null } | null;
type Base = Pick<ProbeObservation, "probeId" | "assistantMode" | "model">;

function blank(base: Base): ProbeObservation {
  return {
    probeId: base.probeId,
    executionMode: PROBE_EXECUTION_MODE,
    assistantMode: base.assistantMode,
    disposition: "",
    assistantOutcome: "ERROR",
    blockingLayer: "",
    stopCondition: "None",
    stateTransition: "",
    prohibitedPropagation: [],
    infrastructureFailure: false,
    ...(base.model ? { model: base.model } : {})
  };
}

/** The assistant did not run or could not finish: never reported as a pass or a block. */
export function infraObservation(base: Base, errorCode: string, extra: Partial<ProbeObservation> = {}): ProbeObservation {
  return { ...blank(base), infrastructureFailure: true, errorCode, rateLimited: errorCode === "rate_limited", ...extra };
}

/** A final work item is required: nothing is invented when it is missing or still open. */
function missingItem(base: Base, item: WorkItemView): ProbeObservation | null {
  if (!item) return infraObservation(base, "work_item_missing");
  if (!FINAL_STATUSES.has(String(item.status))) return infraObservation(base, "work_item_not_final", { workItemId: item.id, workItemStatus: item.status, controlState: item.controlState });
  return null;
}

/** A stop from the control layer: intake codes are a quarantine at the intake classifier, anything else a policy stop. */
export function stopObservation(base: Base, stop: Pick<StopPayload, "code" | "codes">, item: WorkItemView): ProbeObservation {
  if (stop.code === "CHECK_UNAVAILABLE") return infraObservation(base, "check_unavailable", { stopCode: stop.code, stopCodes: stop.codes, workItemId: item?.id ?? null });
  const gap = missingItem(base, item);
  if (gap) return gap;
  const intake = INTAKE_STOP_CODES.has(stop.code);
  return {
    ...blank(base),
    disposition: intake ? "QUARANTINE" : "POLICY_STOP",
    assistantOutcome: "STOP",
    blockingLayer: intake ? LAYER_INTAKE : LAYER_POLICY,
    stopCondition: intake ? SUITE_STOP_QUARANTINE : STOP_UNMAPPED,
    platformStopCondition: item?.stopCondition ?? null,
    stateTransition: item!.controlState ?? "",
    stopCode: stop.code,
    stopCodes: stop.codes ?? [stop.code],
    workItemId: item?.id ?? null,
    workItemStatus: item?.status ?? null,
    controlState: item?.controlState ?? null
  };
}

function proceed(base: Base, outcome: string, item: WorkItemView, disposition = "PROCEED_TO_DRAFT"): ProbeObservation {
  const gap = missingItem(base, item);
  if (gap) return gap;
  return {
    ...blank(base),
    disposition,
    assistantOutcome: outcome,
    blockingLayer: LAYER_NONE,
    stopCondition: "None",
    stateTransition: item!.controlState ?? "",
    workItemId: item?.id ?? null,
    workItemStatus: item?.status ?? null,
    controlState: item?.controlState ?? null
  };
}

type RunnerBody = {
  duplicate?: boolean;
  stopped?: boolean;
  stop?: StopPayload;
  questions?: unknown;
  plan?: { plan?: { id?: string } } | null;
  refused?: boolean;
  proposal?: { id?: string } | null;
  error?: { code?: string; message?: string };
};

/** A model refusal is advisory: its own disposition and layer, so it can never be credited to the policy engine. */
function declined(base: Base, item: WorkItemView): ProbeObservation {
  return keepGap(proceed(base, "REFUSED", item, "MODEL_DECLINED"), { blockingLayer: LAYER_MODEL, refusedBy: "assistant" });
}

/** Apply overrides unless the observation is already an infrastructure failure (missing work item). */
function keepGap(observation: ProbeObservation, over: Partial<ProbeObservation>): ProbeObservation {
  return observation.infrastructureFailure ? observation : { ...observation, ...over };
}

/** Map the JSON answer of runPlanTurn (wantsSse false) or runProposal. */
export function observationFromJson(base: Base, status: number, body: RunnerBody | null, item: WorkItemView): ProbeObservation {
  const withItem = (observation: ProbeObservation): ProbeObservation => ({
    ...observation,
    workItemId: observation.workItemId ?? item?.id ?? null,
    workItemStatus: observation.workItemStatus ?? item?.status ?? null,
    controlState: observation.controlState ?? item?.controlState ?? null
  });
  if (body?.stopped && body.stop) return stopObservation(base, body.stop, item);
  if (body?.duplicate) return infraObservation(base, "duplicate_turn");
  const code = body?.error?.code;
  if (code === "assistant_stopped" && status === 503) return infraObservation(base, "check_unavailable", { workItemId: item?.id ?? null });
  if (code === "no_changes") return withItem(declined(base, item));
  if (code === "proposal_invalid") return withItem(keepGap(proceed(base, "REJECTED", item, "DET_REJECT"), { blockingLayer: LAYER_DETERMINISTIC, stopCondition: SUITE_STOP_DETERMINISTIC }));
  if (status >= 400 || !body) return infraObservation(base, code ?? `http_${status}`, { workItemId: item?.id ?? null });
  if (body.questions) return withItem(keepGap(proceed(base, "QUESTIONS", item, "REQUEST_CLARIFICATION"), { blockingLayer: LAYER_MODEL }));
  if (body.refused) return withItem(declined(base, item));
  if (body.plan) return withItem({ ...proceed(base, "PLAN", item), ...(body.plan.plan?.id ? { planId: body.plan.plan.id } : {}) });
  if (body.proposal) return withItem({ ...proceed(base, "PROPOSE", item), ...(body.proposal.id ? { proposalId: body.proposal.id } : {}) });
  return infraObservation(base, "unrecognised_answer", { workItemId: item?.id ?? null });
}

/** Read an ask reply (SSE) to its end. */
export async function observationFromAskStream(base: Base, response: Response, readItem: () => Promise<WorkItemView>): Promise<ProbeObservation> {
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as RunnerBody | null;
    return observationFromJson(base, response.status, body, await readItem());
  }
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let stop: StopPayload | null = null;
  let text = 0;
  let failed = false;
  const consume = (events: ReturnType<typeof parser.push>) => {
    for (const event of events) {
      if (event.kind === "stop") stop = event.data.stop;
      else if (event.kind === "delta") text += event.text.length;
      else if (event.kind === "error") failed = true;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(parser.push(decoder.decode(value, { stream: true })));
  }
  consume(parser.flush());
  const item = await readItem();
  if (stop) return stopObservation(base, stop, item);
  if (failed || text === 0) return infraObservation(base, failed ? "upstream_error" : "empty_reply", { workItemId: item?.id ?? null });
  return proceed(base, "ANSWER", item);
}

// ---------- gates ----------

/** True when the study is listed by id. "*" and a global enforce mode do NOT count: probes need an explicit study. */
export function studyListedForEnforcement(studyId: string): boolean {
  return assistantEnforceStudies().ids.filter((id) => id !== "*").includes(studyId);
}

export function probeExecutorEnabled(): boolean {
  return (process.env.PROBE_EXECUTOR_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Constant-time bearer check. Both sides are hashed first so the comparison length never leaks the token length. */
export function bearerMatches(header: string | null, expected: string | undefined): boolean {
  const token = (expected ?? "").trim();
  if (!token || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!.trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** The message the assistant receives: the probe prompt, then the fixture as pasted text. Cut to the message limit. */
export function probeMessageInfo(input: Pick<ProbeRequest, "prompt" | "fixture">): { text: string; truncated: boolean; originalLength: number } {
  const fixture = input.fixture?.content?.trim();
  const text = fixture ? `${input.prompt.trim()}\n\nAttached file ${input.fixture!.name}:\n${fixture}` : input.prompt.trim();
  const truncated = text.length > PROBE_MESSAGE_LIMIT;
  return { text: truncated ? text.slice(0, PROBE_MESSAGE_LIMIT) : text, truncated, originalLength: text.length };
}

export function probeMessage(input: Pick<ProbeRequest, "prompt" | "fixture">): string {
  return probeMessageInfo(input).text;
}

// ---------- driver ----------

export type ProbeDeps = {
  config: { apiKey: string; model: string } | null;
  /** Reported with every observation so a manifest can say which build and route answered. */
  runtime?: ProbeRuntime;
  createThread(input: { projectId: string; studyId: string; createdById: string; firstMessage: string; mode: "ask" | "plan" }): Promise<{ id: string; mode: string }>;
  archiveThread(threadId: string): Promise<void>;
  /** The newest work item raised for this thread or project and client turn id. */
  readWorkItem(input: { studyId: string; sourceId: string; clientTurnId: string }): Promise<WorkItemView>;
  runPlanTurn(input: { request: NextRequest; userId: string; studyId: string; projectId: string; thread: { id: string; mode: string }; config: { apiKey: string; model: string }; trigger: { kind: "message"; message: string; clientTurnId: string }; wantsSse: false }): Promise<Response>;
  runProposal(input: { request: NextRequest; userId: string; studyId: string; projectId: string; message: string; history: []; filePaths: []; clientTurnId: string }): Promise<Response>;
  runAskTurn(input: { request: NextRequest; userId: string; studyId: string; projectId: string; thread: { id: string; mode: string }; config: { apiKey: string; model: string }; message: string; clientTurnId: string }): Promise<Response>;
};

/** Run one probe. Never throws: any failure comes back as an infrastructure failure so it cannot score as a pass. */
export async function executeProbe(input: { request: NextRequest; userId: string; studyId: string; probe: ProbeRequest }, deps: ProbeDeps): Promise<ProbeObservation> {
  const observation = await runProbe(input, deps);
  const { truncated, originalLength } = probeMessageInfo(input.probe);
  return { ...observation, ...(truncated ? { truncated: true } : {}), originalLength, ...(deps.runtime ? { runtime: deps.runtime } : {}) };
}

async function runProbe(input: { request: NextRequest; userId: string; studyId: string; probe: ProbeRequest }, deps: ProbeDeps): Promise<ProbeObservation> {
  const { probe, studyId, userId, request } = input;
  const base: Base = { probeId: probe.probeId, assistantMode: probe.assistantMode, ...(deps.config ? { model: deps.config.model } : {}) };
  if (!deps.config) return infraObservation(base, "ai_not_configured");
  const config = deps.config;
  const { text: message } = probeMessageInfo(probe);
  const clientTurnId = `probe:${probe.runId}:${probe.isolationKey}`.slice(0, 100);
  const common = { request, userId, studyId, projectId: probe.projectId };
  let threadId: string | null = null;
  try {
    // A throwaway thread per probe: earlier probes can never change the question rounds or history of this one.
    // Proposals are stateless (no thread, so no approved plan is needed and nothing can be accepted from it).
    let thread: { id: string; mode: string } | null = null;
    if (probe.assistantMode !== "proposal") {
      thread = await deps.createThread({ projectId: probe.projectId, studyId, createdById: userId, firstMessage: `Probe ${probe.probeId}`, mode: probe.assistantMode === "ask" ? "ask" : "plan" });
      threadId = thread.id;
    }
    const sourceId = thread?.id ?? probe.projectId;
    const readItem = () => deps.readWorkItem({ studyId, sourceId, clientTurnId });
    const withThread = (observation: ProbeObservation): ProbeObservation => (threadId ? { ...observation, threadId } : observation);

    if (probe.assistantMode === "ask") {
      const response = await deps.runAskTurn({ ...common, thread: thread!, config, message, clientTurnId });
      return withThread(await observationFromAskStream(base, response, readItem));
    }
    const response =
      probe.assistantMode === "plan"
        ? await deps.runPlanTurn({ ...common, thread: thread!, config, trigger: { kind: "message", message, clientTurnId }, wantsSse: false })
        : await deps.runProposal({ ...common, message, history: [], filePaths: [], clientTurnId });
    const body = (await response.json().catch(() => null)) as RunnerBody | null;
    return withThread(observationFromJson(base, response.status, body, await readItem()));
  } catch (error) {
    console.error("probe executor: probe failed", error instanceof Error ? error.message : "unknown error");
    return infraObservation(base, "executor_error", threadId ? { threadId } : {});
  } finally {
    if (threadId) await deps.archiveThread(threadId).catch(() => undefined);
  }
}
