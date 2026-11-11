/**
 * The only place the assistant touches control-plane code.
 *
 * Two ways in:
 *  - SHADOW (openAssistantTurn / beginAssistantTurn): every turn is evaluated and recorded, nothing is ever blocked and
 *    the person sees no change. This is what runs unless the study enforces.
 *  - ENFORCE (guardAssistantTurn, only when effectiveControlMode(studyId) is "enforce"): the runner waits for the check
 *    before any model call. A quarantine verdict, a policy refusal, or a check that cannot finish (timeout, ledger
 *    error) means NO model call; the runner stores a short notice instead.
 *
 * Safety rules, relied on by the runners:
 *  - mode "off" returns before any database call;
 *  - every public function catches everything, logs one console.warn without user text, and carries on;
 *  - every database sequence is bounded by a short timeout, after which the turn proceeds;
 *  - what is written holds hashes, lengths, ids, reason codes and a redacted preview, never the text itself.
 *
 * Why a dedicated policy (evaluateAssistantPolicy) instead of evaluateWorkItemPolicy: that function matches probe
 * phrases (for example "any shell command", "change ... work-item") in evidence text and knows nothing about modes,
 * contracts or tool scope. Applied to chat it would gate ordinary wording. The dedicated policy is deny-by-default
 * over the facts the assistant actually has: a known mode, an active contract, and tools inside that contract.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hmacSha256, sha256 } from "@/lib/crypto";
import { assistantControlMode, effectiveControlMode } from "@/lib/runtime-config";
import { stopPayloadFor, withheldNote, type StopPayload } from "@/lib/terms";
import {
  CONTROL_POLICY_VERSION,
  SIGNING_KEY_ID,
  assertTransition,
  contentHash,
  controlSigningSecret,
  signControlPayload,
  type ControlState
} from "@/lib/control-plane";
import { buildWorkItemSignedPayload } from "@/lib/control-plane-store";
import {
  authoritativeIntakeSchema,
  inspectAssistantIntake,
  resolveDeterministicIntake,
  type AuthoritativeLayer
} from "@/lib/control-intake";

export type AssistantMode = "ask" | "plan" | "agent" | "edit" | "answers";
export type AssistantOutcome = "done" | "error" | "stopped" | "no_changes" | "refused";
export type AssistantReason = { code: string; layer: AuthoritativeLayer };

export const CONTROL_TIMEOUT_MS = 1500;
/** In enforce the runner waits for the check, so it gets a longer (still bounded) deadline. */
export const ENFORCE_TIMEOUT_MS = 3000;

export type ContractKey = "assistant.ask.v1" | "assistant.plan.v1" | "assistant.change.v1" | "assistant.verify.v1";

const CONTRACTS: Record<ContractKey, { allowedTools: string[]; tokenBudget: number; timeBudgetSeconds: number; purpose: string }> = {
  "assistant.ask.v1": { allowedTools: [], tokenBudget: 16_000, timeBudgetSeconds: 180, purpose: "Assistant answer (read only)" },
  "assistant.plan.v1": { allowedTools: [], tokenBudget: 24_000, timeBudgetSeconds: 180, purpose: "Assistant plan (no code, no files)" },
  "assistant.change.v1": { allowedTools: ["propose_file_changes"], tokenBudget: 60_000, timeBudgetSeconds: 240, purpose: "Assistant code proposal (nothing is saved until accepted)" },
  "assistant.verify.v1": { allowedTools: [], tokenBudget: 8_000, timeBudgetSeconds: 45, purpose: "Assistant second check (advice only)" }
};

const MODE_CONTRACT: Record<AssistantMode, Exclude<ContractKey, "assistant.verify.v1">> = {
  ask: "assistant.ask.v1",
  plan: "assistant.plan.v1",
  answers: "assistant.plan.v1",
  agent: "assistant.change.v1",
  edit: "assistant.change.v1"
};

const POLICY_LAYER: AuthoritativeLayer = "Policy engine / work-item contract";
const INTAKE_REQUIREMENTS = ["R14", "R16", "R17", "R20"];

/** Budgets and purpose of a contract, for callers that sign their own payload (the second check). */
export function contractSpec(key: ContractKey) {
  return CONTRACTS[key];
}

export type AssistantPolicyResult = { passed: boolean; reasonCodes: string[] };

/** Deny by default: the mode must be known, its contract active, and every tool the turn may use inside that contract. */
export function evaluateAssistantPolicy(input: { mode: string; contract: { name: string; active: boolean; allowedTools: string[] } | null; requestedTools: string[] }): AssistantPolicyResult {
  const reasonCodes: string[] = [];
  const expected = MODE_CONTRACT[input.mode as AssistantMode];
  if (!expected) reasonCodes.push("MODE_UNKNOWN");
  if (!input.contract || !input.contract.active) reasonCodes.push("CONTRACT_MISSING");
  else if (expected && input.contract.name !== expected) reasonCodes.push("CONTRACT_MODE_MISMATCH");
  if (input.contract && input.requestedTools.some((tool) => !input.contract!.allowedTools.includes(tool))) reasonCodes.push("TOOL_OUTSIDE_CONTRACT");
  return { passed: reasonCodes.length === 0, reasonCodes };
}

export type BeginAssistantTurnInput = {
  studyId: string;
  projectId: string;
  threadId?: string | null;
  userId: string;
  mode: AssistantMode;
  clientTurnId: string;
  /** Only what the person typed or pasted in this turn. Never repository files or the context pack. */
  userText: string;
  selection?: string | null;
  answers?: Record<string, string | string[]> | null;
  /** Turn rows to link to the work item. More can be linked when the turn finishes. */
  turnIds?: string[];
  timeoutMs?: number;
};

export type BeginAssistantTurnResult = {
  mode: "off" | "shadow" | "enforce";
  workItemId: string | null;
  verdict: "clear" | "quarantine";
  wouldBlock: boolean;
  reasons: AssistantReason[];
  elapsedMs: number;
  /** True when nothing was recorded (timeout, error) or the record was written after the timeout. */
  incomplete?: boolean;
};

export type FinishAssistantTurnInput = {
  workItemId: string;
  outcome: AssistantOutcome;
  turnIds?: string[];
  model?: string | null;
  tokens?: { input?: number | null; output?: number | null };
  timeoutMs?: number;
};

function warn(label: string, error: unknown) {
  // Names and codes only: Prisma messages can echo query values.
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const name = error instanceof Error ? error.name : "unknown";
  console.warn(`assistant-control: ${label} failed (${name}${code ? ` ${code}` : ""}); the turn continues`);
}

/** Runs `work` with a deadline. Resolves with `fallback` on timeout or error; never rejects. */
async function bounded<T>(label: string, timeoutMs: number, fallback: T, work: (state: { timedOut: boolean }) => Promise<T>): Promise<T> {
  const state = { timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      resolve("timeout");
    }, timeoutMs);
  });
  let running: Promise<T>;
  try {
    running = Promise.resolve(work(state));
  } catch (error) {
    clearTimeout(timer);
    warn(label, error);
    return fallback;
  }
  running.catch((error) => {
    if (state.timedOut) warn(`${label} (after timeout)`, error);
  });
  try {
    const result = await Promise.race([running, timeout]);
    if (result === "timeout") {
      warn(label, new Error("timeout"));
      return fallback;
    }
    return result;
  } catch (error) {
    warn(label, error);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Digest of the turn text for the ledger. Keyed with the control secret when one is configured, so a short secret
 * cannot be recovered by hashing a dictionary; falls back to a plain hash when no secret exists.
 */
function textDigest(text: string, strict = false): string {
  try {
    return hmacSha256(controlSigningSecret(), text);
  } catch (error) {
    // Enforced: a plain hash of a short secret can be guessed, so no secret means nothing is recorded (the guard then fails closed).
    if (strict) throw error;
    return sha256(text);
  }
}

function flattenAnswers(answers: BeginAssistantTurnInput["answers"]): string {
  if (!answers) return "";
  return Object.values(answers).map((value) => (Array.isArray(value) ? value.join("\n") : String(value))).join("\n");
}

/** The full probe cascade, for comparison only. It is tuned to probe wording and must never gate chat. */
function probeCascade(text: string) {
  try {
    const request = authoritativeIntakeSchema.safeParse({ requestText: text.slice(0, 8000) || " ", attachments: [] });
    if (!request.success) return { evaluated: false as const, reason: "input_not_valid_for_probe" };
    const resolution = resolveDeterministicIntake(request.data);
    if (!resolution) return { evaluated: true as const, matched: false as const };
    return {
      evaluated: true as const,
      matched: true as const,
      disposition: resolution.disposition,
      authoritativeLayer: resolution.authoritativeLayer,
      stoppingCondition: resolution.stoppingCondition,
      controlState: resolution.controlState,
      reasonCodes: resolution.reasonCodes,
      maySendToModel: resolution.maySendToModel
    };
  } catch {
    return { evaluated: false as const, reason: "probe_error" };
  }
}

export async function ensureContract(studyId: string, userId: string, key: ContractKey) {
  const found = await prisma.skillContract.findFirst({ where: { studyId, name: key, active: true } });
  if (found) return found;
  const spec = CONTRACTS[key];
  const definition = {
    name: key,
    role: "ASSISTANT",
    requirements: INTAKE_REQUIREMENTS,
    allowedTools: spec.allowedTools,
    allowedEvidence: ["USER_TURN_HASH", "PROJECT_CONTEXT_HASH"],
    outputSchema: { type: "object", required: ["outcome"] },
    tokenBudget: spec.tokenBudget,
    timeBudgetSeconds: spec.timeBudgetSeconds
  };
  try {
    return await prisma.skillContract.create({
      data: {
        studyId,
        ...definition,
        outputSchema: definition.outputSchema as Prisma.InputJsonValue,
        contractHash: contentHash({ studyId, policyVersion: CONTROL_POLICY_VERSION, definition }),
        createdById: userId
      }
    });
  } catch (error) {
    // Another turn created it first.
    const again = await prisma.skillContract.findFirst({ where: { studyId, name: key, active: true } });
    if (again) return again;
    throw error;
  }
}

async function linkTurns(turnIds: string[] | undefined, data: { workItemId: string; controlState: string; stopCondition: string | null }) {
  if (!turnIds || turnIds.length === 0) return;
  await prisma.agentTurn.updateMany({ where: { id: { in: turnIds } }, data });
}

/**
 * Evaluate and record one assistant turn. Never throws and never blocks the caller beyond `timeoutMs`.
 * In "off" mode it returns at once without touching the database.
 */
export async function beginAssistantTurn(input: BeginAssistantTurnInput): Promise<BeginAssistantTurnResult> {
  return (await beginWithSettled(input)).result;
}

type Begun = { result: BeginAssistantTurnResult; /** Resolves with the work item id once the write really ends, even after the timeout; null when it failed. */ settled: Promise<string | null> };

async function beginWithSettled(input: BeginAssistantTurnInput, enforce = false): Promise<Begun> {
  const started = Date.now();
  let settle: (id: string | null) => void = () => undefined;
  const settled = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const result = await beginInner(input, started, settle, enforce);
  if (!result.workItemId && !result.incomplete) settle(null);
  if (result.mode === "off") settle(null);
  return { result, settled };
}

async function beginInner(input: BeginAssistantTurnInput, started: number, settle: (id: string | null) => void, enforce: boolean): Promise<BeginAssistantTurnResult> {
  const mode = enforce ? "enforce" : assistantControlMode();
  const base: BeginAssistantTurnResult = { mode, workItemId: null, verdict: "clear", wouldBlock: false, reasons: [], elapsedMs: 0 };
  if (mode === "off") return base;
  try {
    const text = [input.userText, input.selection ?? "", flattenAnswers(input.answers)].filter(Boolean).join("\n\n");
    const intake = inspectAssistantIntake(text);
    const evaluated: BeginAssistantTurnResult = {
      ...base,
      verdict: intake.verdict,
      wouldBlock: intake.verdict === "quarantine",
      reasons: intake.reasons
    };
    const recorded = await bounded<{ workItemId: string; controlState: string; stopCondition: string | null; policyReasons: string[]; late: boolean } | null>(
      "begin",
      input.timeoutMs ?? (enforce ? ENFORCE_TIMEOUT_MS : CONTROL_TIMEOUT_MS),
      null,
      async (state) => {
        try {
          const done = await recordTurn(input, text, intake, started, state, enforce);
          settle(done.workItemId);
          return done;
        } catch (error) {
          settle(null);
          throw error;
        }
      }
    );

    const policyReasons: AssistantReason[] = (recorded?.policyReasons ?? []).map((code) => ({ code, layer: POLICY_LAYER }));
    const reasons = [...intake.reasons, ...policyReasons];
    return {
      ...evaluated,
      workItemId: recorded?.workItemId ?? null,
      wouldBlock: evaluated.wouldBlock || policyReasons.length > 0,
      reasons,
      elapsedMs: Date.now() - started,
      ...(recorded === null || recorded.late ? { incomplete: true } : {})
    };
  } catch (error) {
    warn("begin", error);
    settle(null);
    return { ...base, elapsedMs: Date.now() - started, incomplete: true };
  }
}

async function recordTurn(
  input: BeginAssistantTurnInput,
  text: string,
  intake: ReturnType<typeof inspectAssistantIntake>,
  started: number,
  state: { timedOut: boolean },
  enforce: boolean
) {
  const { studyId, userId, mode: assistantMode } = input;
  const sourceType = input.threadId ? "agent_thread" : "agent_project";
  const sourceId = input.threadId ?? input.projectId;
  // Scoped to the thread (or project) so a reused client id in another thread cannot attach to this one's item.
  const baseKey = `turn:${sourceId}:${input.clientTurnId}`;

  // A retry of the same client turn id after the first attempt ended (for example resent answers) is a new attempt
  // and gets its own work item (":r1", ":r2", ...). A work item that is still open is the same attempt: reuse it.
  let idempotencyKey = baseKey;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    idempotencyKey = attempt === 0 ? baseKey : `${baseKey}:r${attempt}`;
    const existing = await prisma.workItem.findFirst({ where: { studyId, idempotencyKey } });
    if (!existing) break;
    const closed = existing.controlState === "STOPPED" || existing.controlState === "WORKER_COMPLETED" || existing.controlState === "EXPORTED";
    if (!closed && existing.sourceId === sourceId) {
      await linkTurns(input.turnIds, { workItemId: existing.id, controlState: existing.controlState, stopCondition: existing.stopCondition });
      return { workItemId: existing.id, controlState: existing.controlState as string, stopCondition: (existing.stopCondition as string | null) ?? null, policyReasons: [] as string[], late: false };
    }
    // After the last numbered attempt a random suffix keeps the unique key free, so a reused turn id is never stuck.
    if (attempt === 7) idempotencyKey = `${baseKey}:${randomUUID()}`;
  }

  const contractKey = MODE_CONTRACT[assistantMode];
  const contract = await ensureContract(studyId, userId, contractKey);
  const spec = CONTRACTS[contractKey];
  const policy = evaluateAssistantPolicy({ mode: assistantMode, contract, requestedTools: spec.allowedTools });
  const quarantined = intake.verdict === "quarantine";

  const digest = textDigest(text, enforce);
  const inputHash = contentHash({ assistantMode, projectId: input.projectId, threadId: input.threadId ?? null, sourceType, sourceId, clientTurnId: input.clientTurnId, textHash: digest, textChars: text.length });
  const tokenBudget = contract.tokenBudget ?? spec.tokenBudget;
  const timeBudgetSeconds = contract.timeBudgetSeconds ?? spec.timeBudgetSeconds;
  // Exactly the payload every verifier rebuilds from the row. Mode, thread and client turn id are bound via inputHash.
  const signedPayload = buildWorkItemSignedPayload({ studyId, requestedById: userId, contract, purpose: spec.purpose, inputHash, evidenceIds: [], allowedTools: spec.allowedTools, tokenBudget, timeBudgetSeconds, expiresAt: null });
  let signature: string | null = null;
  let signing: "signed" | "not_signed_would_block" | "unavailable" = "not_signed_would_block";
  if (policy.passed && !quarantined) {
    try {
      signature = signControlPayload(signedPayload);
      signing = "signed";
    } catch {
      signing = "unavailable";
      // Enforce fails closed: an unsigned work item is not evidence of a check, so nothing is recorded and no model call follows.
      if (enforce) throw new Error("signing unavailable");
    }
  }

  let controlState: ControlState;
  let status: "DRAFT" | "SIGNED" | "FAILED";
  let stopCondition: "STOP_1_INTAKE" | "STOP_5_POLICY" | null = null;
  if (!policy.passed) {
    controlState = "STOPPED";
    status = "FAILED";
    stopCondition = "STOP_5_POLICY";
  } else if (quarantined && enforce) {
    // Enforced: the item ends here. QUARANTINED -> STOPPED is a legal hop, so it is recorded as the end state directly.
    controlState = "STOPPED";
    status = "FAILED";
    stopCondition = "STOP_1_INTAKE";
  } else if (quarantined) {
    controlState = "QUARANTINED";
    status = "DRAFT";
    stopCondition = "STOP_1_INTAKE";
  } else if (signature) {
    controlState = "WORK_ITEM_SIGNED";
    status = "SIGNED";
  } else {
    controlState = "POLICY_AUTHORIZED";
    status = "DRAFT";
  }

  const cascade = probeCascade(text);
  const reasons: AssistantReason[] = [...intake.reasons, ...policy.reasonCodes.map((code) => ({ code, layer: POLICY_LAYER }))];
  let late = state.timedOut;

  const result = await prisma.$transaction(async (tx) => {
    const item = await tx.workItem.create({
      data: {
        studyId,
        skillContractId: contract.id,
        requestedById: userId,
        idempotencyKey,
        status,
        controlState,
        stopCondition,
        purpose: spec.purpose,
        inputHash,
        evidenceIds: [],
        allowedTools: spec.allowedTools,
        tokenBudget,
        timeBudgetSeconds,
        signature,
        signatureKeyId: signature ? SIGNING_KEY_ID : null,
        startedAt: new Date(),
        completedAt: controlState === "STOPPED" ? new Date() : null,
        sourceType,
        sourceId
      }
    });
    let quarantineId: string | null = null;
    if (quarantined) {
      const quarantine = await tx.quarantineRecord.create({
        data: {
          studyId,
          sourceType: enforce ? "ASSISTANT_TURN" : "ASSISTANT_TURN_SHADOW",
          sourceLocator: `assistant://${sourceType}/${sourceId}/turn/${input.clientTurnId}`,
          contentHash: digest,
          reasonCodes: intake.reasons.map(({ code }) => code),
          // Enforced records hold only a keyed hash, reason codes and counts: no preview, no text.
          metadata: (enforce
            ? { workItemId: item.id, assistantMode, threadId: input.threadId ?? null, chars: text.length, hasSelection: Boolean(input.selection), answerCount: input.answers ? Object.keys(input.answers).length : 0 }
            : { shadow: true, workItemId: item.id, assistantMode, threadId: input.threadId ?? null, chars: text.length, redactedPreview: intake.redactedPreview }) as Prisma.InputJsonValue,
          quarantinedById: userId
        }
      });
      quarantineId = quarantine.id;
    }
    late = late || state.timedOut;
    const decision = {
      policyVersion: CONTROL_POLICY_VERSION,
      kind: "assistant_turn",
      controlMode: enforce ? "enforce" : assistantControlMode(),
      enforcement: enforce ? "enforced" : "shadow_only",
      assistantMode,
      contractKey,
      workItemId: item.id,
      assistant: {
        verdict: intake.verdict,
        wouldBlock: quarantined || !policy.passed,
        reasons,
        policy,
        signing
      },
      // The full probe cascade on the same text, kept for comparison only. It never decides anything here.
      shadow: cascade,
      input: { chars: text.length, textHash: digest, hasSelection: Boolean(input.selection), answerCount: input.answers ? Object.keys(input.answers).length : 0 },
      quarantineId,
      elapsedMs: Date.now() - started,
      ...(late ? { incomplete: true, incompleteReason: "written after the control timeout" } : {})
    };
    await tx.decisionRecord.create({
      data: {
        studyId,
        decisionType: "ASSISTANT_TURN",
        decision: decision as unknown as Prisma.InputJsonValue,
        rationale: reasons.length > 0 ? reasons.map(({ code }) => code).join(", ") : `Assistant turn passed intake and policy (${enforce ? "enforced" : "shadow"}).`,
        evidenceIds: [],
        artifactIds: [],
        decisionHash: contentHash({ studyId, workItemId: item.id, decision }),
        decidedById: userId
      }
    });
    return item;
  }, { timeout: enforce ? ENFORCE_TIMEOUT_MS : CONTROL_TIMEOUT_MS, maxWait: 500 });

  late = late || state.timedOut;
  await linkTurns(input.turnIds, { workItemId: result.id, controlState, stopCondition });
  return { workItemId: result.id, controlState: controlState as string, stopCondition: stopCondition as string | null, policyReasons: policy.reasonCodes, late };
}

const COMPLETION_PATH: ControlState[] = ["POLICY_AUTHORIZED", "WORK_ITEM_SIGNED", "EVIDENCE_ASSEMBLED", "WORKER_COMPLETED"];

/**
 * The state a work item ends in. Every hop is checked with assertTransition, so the ledger cannot jump states.
 * An item that was never signed (no signing secret) is never reported as completed: it ends STOPPED.
 */
function terminalState(current: ControlState, outcome: AssistantOutcome, signed: boolean): ControlState {
  if (current === "STOPPED" || current === "EXPORTED" || current === "WORKER_COMPLETED") return current;
  const completes = outcome === "done" || outcome === "no_changes" || outcome === "refused";
  if (completes && signed && COMPLETION_PATH.includes(current)) {
    for (let index = COMPLETION_PATH.indexOf(current); index < COMPLETION_PATH.length - 1; index += 1) {
      assertTransition(COMPLETION_PATH[index]!, COMPLETION_PATH[index + 1]!);
    }
    return "WORKER_COMPLETED";
  }
  assertTransition(current, "STOPPED");
  return "STOPPED";
}

/** Record how the turn ended and move its work item to the terminal state. Never throws. */
export async function finishAssistantTurn(input: FinishAssistantTurnInput): Promise<void> {
  if (assistantControlMode() === "off") return;
  await bounded<void>("finish", input.timeoutMs ?? CONTROL_TIMEOUT_MS, undefined, async () => {
    const item = await prisma.workItem.findUnique({ where: { id: input.workItemId } });
    if (!item) return;
    const signed = Boolean(item.signature);
    const target = terminalState(item.controlState as ControlState, input.outcome, signed);
    const status = target === "WORKER_COMPLETED" ? "COMPLETED" : input.outcome === "stopped" ? "CANCELLED" : "FAILED";
    const unsigned = !signed && item.controlState === "POLICY_AUTHORIZED";
    await prisma.$transaction(async (tx) => {
      // The state change goes first: if another writer moved the item, the version check matches nothing and no
      // execution row is added on top of a state this call did not set.
      if (target !== item.controlState) {
        const moved = await tx.workItem.updateMany({
          where: { id: item.id, version: item.version },
          data: { controlState: target, status, completedAt: new Date(), version: { increment: 1 } }
        });
        if (moved.count === 0) return;
      }
      const existingExecution = await tx.agentExecution.findFirst({ where: { workItemId: item.id }, select: { id: true } });
      if (!existingExecution) {
        await tx.agentExecution.create({
          data: {
            studyId: item.studyId,
            workItemId: item.id,
            role: "ASSISTANT",
            provider: "openai",
            model: input.model ?? "unknown",
            promptHash: item.inputHash,
            evidenceHash: contentHash(item.evidenceIds),
            inputTokens: input.tokens?.input ?? null,
            outputTokens: input.tokens?.output ?? null,
            stopReason: unsigned ? `${input.outcome}:unsigned_shadow` : input.outcome,
            verificationStatus: "NOT_VERIFIED_SHADOW",
            completedAt: new Date()
          }
        });
      }
    }, { timeout: CONTROL_TIMEOUT_MS, maxWait: 500 });
    await linkTurns(input.turnIds, { workItemId: item.id, controlState: target, stopCondition: (item.stopCondition as string | null) ?? null });
  });
}

export type AssistantTurnHandle = {
  /** Records the outcome once; later calls do nothing. Never rejects, safe to call without await. */
  done(outcome: AssistantOutcome, extra?: { turnIds?: string[]; model?: string | null; tokens?: FinishAssistantTurnInput["tokens"] }): Promise<void>;
};

const NOOP_HANDLE: AssistantTurnHandle = { done: async () => undefined };

/** How long done() waits for a begin write that missed its deadline, so the item can still be finished. */
const LATE_BEGIN_WAIT_MS = 6000;

async function waitFor<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the runners call. Starts the evaluation without waiting for it (the model call is never delayed) and returns a
 * handle whose done() waits for the evaluation, then records the outcome. In "off" mode nothing happens at all.
 * If the evaluation missed its deadline but the write still lands, done() waits for it and finishes the item, so no
 * work item is left open.
 */
export function openAssistantTurn(input: BeginAssistantTurnInput): AssistantTurnHandle {
  try {
    if (assistantControlMode() === "off") return NOOP_HANDLE;
    const begun = beginWithSettled(input).catch(() => null);
    let finished = false;
    return {
      async done(outcome, extra) {
        if (finished) return;
        finished = true;
        try {
          const started = await begun;
          if (!started) return;
          let workItemId = started.result.workItemId;
          if (!workItemId && started.result.incomplete) workItemId = await waitFor(started.settled, LATE_BEGIN_WAIT_MS, null);
          if (!workItemId) return;
          await finishAssistantTurn({ workItemId, outcome, turnIds: [...(input.turnIds ?? []), ...(extra?.turnIds ?? [])], model: extra?.model, tokens: extra?.tokens, timeoutMs: input.timeoutMs });
        } catch (error) {
          warn("done", error);
        }
      }
    };
  } catch (error) {
    warn("open", error);
    return NOOP_HANDLE;
  }
}


// ---------- enforce ----------

export type AssistantGate =
  | { enforced: false }
  | {
      enforced: true;
      blocked: false;
      workItemId: string;
      /** Finishes the work item. Same contract as the shadow handle. */
      handle: AssistantTurnHandle;
      /** Link stored turns to the work item. Never throws. */
      link(turnIds: string[]): Promise<void>;
    }
  | {
      enforced: true;
      blocked: true;
      stop: StopPayload;
      /** The note that replaces the person's message in the thread, or null when the message is not stored at all. */
      withheld: string | null;
      workItemId: string | null;
      link(turnIds: string[]): Promise<void>;
    };

const CONTENT_CODES = new Set(["SENSITIVE_CONTENT", "RAW_CLINICAL_DATA", "ACTIVE_CONTENT", "PROMPT_INJECTION", "MODEL_UPDATE_ARTIFACT"]);

function handleFor(workItemId: string, input: BeginAssistantTurnInput): AssistantTurnHandle {
  let finished = false;
  return {
    async done(outcome, extra) {
      if (finished) return;
      finished = true;
      try {
        await finishAssistantTurn({ workItemId, outcome, turnIds: [...(input.turnIds ?? []), ...(extra?.turnIds ?? [])], model: extra?.model, tokens: extra?.tokens, timeoutMs: input.timeoutMs });
      } catch (error) {
        warn("done", error);
      }
    }
  };
}

/**
 * The enforce entry point. Call it BEFORE the user turn is stored and before any model call.
 * In "off" and "shadow" (for this study) it returns { enforced: false } and does nothing: the runner then uses
 * openAssistantTurn exactly as before.
 *
 * Fail closed: a quarantine verdict, a policy refusal, a timeout or any ledger error returns blocked = true. The
 * caller must then make NO model call and store only what `stop` / `withheld` allow.
 */
export async function guardAssistantTurn(input: BeginAssistantTurnInput): Promise<AssistantGate> {
  if (effectiveControlMode(input.studyId) !== "enforce") return { enforced: false };
  const noLink = async () => undefined;
  try {
    const { result, settled } = await beginWithSettled({ ...input, turnIds: [] }, true);
    const link = (workItemId: string | null, controlState: string, stopCondition: string | null) => async (turnIds: string[]) => {
      if (!workItemId || turnIds.length === 0) return;
      await bounded<void>("link", CONTROL_TIMEOUT_MS, undefined, () => linkTurns(turnIds, { workItemId, controlState, stopCondition }));
    };
    const intakeCodes = result.reasons.filter((reason) => reason.layer === "Intake classifier").map((reason) => reason.code);
    if (result.verdict === "quarantine" && intakeCodes.length > 0) {
      const stop = stopPayloadFor(result.reasons.map((reason) => reason.code));
      return { enforced: true, blocked: true, stop, withheld: CONTENT_CODES.has(stop.code) ? withheldNote(stop.code) : null, workItemId: result.workItemId, link: link(result.workItemId, "STOPPED", "STOP_1_INTAKE") };
    }
    if (result.wouldBlock && result.workItemId) {
      const stop = stopPayloadFor(["POLICY_REFUSED", ...result.reasons.map((reason) => reason.code)]);
      return { enforced: true, blocked: true, stop, withheld: null, workItemId: result.workItemId, link: link(result.workItemId, "STOPPED", "STOP_5_POLICY") };
    }
    if (!result.workItemId || result.incomplete) {
      // The write may still land after the deadline: close that item so nothing stays open for a turn that did not run.
      void settled.then((late) => (late ? finishAssistantTurn({ workItemId: late, outcome: "stopped" }) : undefined)).catch(() => undefined);
      return { enforced: true, blocked: true, stop: stopPayloadFor(["CHECK_UNAVAILABLE"]), withheld: null, workItemId: null, link: noLink };
    }
    const workItemId = result.workItemId;
    return {
      enforced: true,
      blocked: false,
      workItemId,
      handle: handleFor(workItemId, input),
      link: link(workItemId, "WORK_ITEM_SIGNED", null)
    };
  } catch (error) {
    warn("guard", error);
    return { enforced: true, blocked: true, stop: stopPayloadFor(["CHECK_UNAVAILABLE"]), withheld: null, workItemId: null, link: noLink };
  }
}
