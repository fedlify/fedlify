import { describe, expect, it } from "vitest";
import {
  buildChatItems,
  canApprovePlan,
  canSubmitAnswers,
  effectivePlanStatus,
  initialApprovedSteps,
  initialDraft,
  initialStream,
  mergeTurns,
  pickInitialThread,
  reduceStream,
  selectOption,
  setOther,
  threadsUnavailable,
  toAnswers,
  toThreadView,
  toggleStep,
  turnModeFor,
  withThreadParam,
  failureFrom
} from "@/lib/agent-thread-client";
import { createSseParser, interpretEvent } from "@/lib/assistant-stream";
import type { PlanDto, PlanQuestion, ThreadSummaryDto, TurnDto } from "@/lib/agent-thread-types";

const turn = (seq: number, over: Partial<TurnDto> = {}): TurnDto => ({
  id: `t${seq}`, threadId: "th", seq, role: "ASSISTANT", kind: "MESSAGE", content: `m${seq}`, payload: null, status: "done", actorUserId: null,
  model: null, promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null,
  createdAt: "2026-11-11T00:00:00Z", ...over
});
const q = (over: Partial<PlanQuestion> = {}): PlanQuestion => ({
  id: "q1", text: "Which?", multi: false, allowOther: true,
  options: [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true }], ...over
});
const plan = (over: Partial<PlanDto> = {}): PlanDto => ({
  id: "p1", threadId: "th", version: 1, summary: "s", baseCommit: "abc", contextHash: "h", requirementsHash: "r", status: "DRAFT", approvedStepIds: null,
  decidedById: null, decidedAt: null, createdAt: "x",
  steps: [
    { id: "s1", title: "One", paths: ["a.py"], action: "update", rationale: "", risk: "low", optional: false, enabled: true },
    { id: "s2", title: "Two", paths: ["b.py"], action: "create", rationale: "", risk: "low", optional: true, enabled: false }
  ],
  assumptions: [{ id: "as1", text: "mu from requirements", needsAck: true }], ...over
});

describe("thread hydration", () => {
  it("rebuilds the chat after reload: messages, questions with their answers, plan, proposal, folded steps", () => {
    const turns = [
      turn(1, { role: "USER", content: "add fedprox" }),
      turn(2, { kind: "QUESTIONS", payload: { round: 1, questions: [q()] } }),
      turn(3, { role: "USER", kind: "ANSWERS", payload: { questionsTurnId: "t2", answers: { q1: "b" } } }),
      turn(4, { kind: "PLAN", planId: "p1" }),
      turn(5, { role: "USER", kind: "PLAN_DECISION", payload: { planId: "p1", decision: "approve" } }),
      turn(6, { kind: "PROPOSAL", payload: { proposalId: "pr1" } })
    ];
    const items = buildChatItems(turns, [plan()]);
    expect(items.map((i) => i.type)).toEqual(["message", "questions", "steps", "plan", "steps", "proposal"]);
    const questions = items[1];
    expect(questions.type === "questions" && questions.answered?.answers).toEqual({ q1: "b" });
    const steps = items[4];
    expect(steps.type === "steps" && steps.steps[0].label).toBe("Plan v1 approved");
    const proposal = items[5];
    expect(proposal.type === "proposal" && proposal.proposalId).toBe("pr1");
  });

  it("merges turns by id and keeps seq order", () => {
    const merged = mergeTurns([turn(1), turn(2, { status: "streaming", content: "x" })], [turn(2, { content: "xy" }), turn(3)]);
    expect(merged.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(merged[1].content).toBe("xy");
  });

  it("gives the audit role a view with no turns, plans or proposals", () => {
    const thread = { id: "th" } as ThreadSummaryDto;
    const view = toThreadView({ thread, access: { level: "auditor", readOnly: true, canDecidePlan: false, canArchive: false }, metadataOnly: true });
    expect(view).toMatchObject({ metadataOnly: true, readOnly: true, canDecidePlan: false, turns: [], plans: [], proposals: [] });
  });

  it("marks another user's thread read-only", () => {
    const view = toThreadView({ thread: { id: "th" } as ThreadSummaryDto, access: { level: "manager", readOnly: true, canDecidePlan: false, canArchive: true }, turns: [turn(2), turn(1)] });
    expect(view.readOnly).toBe(true);
    expect(view.turns.map((t) => t.seq)).toEqual([1, 2]);
  });
});

describe("stream reducer and events", () => {
  it("accumulates text, ids and structured results", () => {
    let state = initialStream();
    state = reduceStream(state, { kind: "turn", data: { threadId: "th", userTurnId: "u", userSeq: 1, assistantTurnId: "a", assistantSeq: 2 } });
    state = reduceStream(state, { kind: "delta", text: "Hel" });
    state = reduceStream(state, { kind: "delta", text: "lo" });
    expect(state).toMatchObject({ content: "Hello", assistantTurnId: "a", userTurnId: "u", status: "streaming" });
    expect(reduceStream(state, { kind: "done" }).status).toBe("done");
    expect(reduceStream(state, { kind: "error", message: "x" })).toMatchObject({ status: "error", error: "x" });
    const withPlan = reduceStream(state, { kind: "plan", data: { threadId: "th", turnId: "a", seq: 2, plan: plan() } });
    expect(withPlan.structured).toBe(true);
  });

  it("parses the new thread events flat or nested and ignores malformed ones", () => {
    expect(interpretEvent({ type: "fedlify.turn", threadId: "th", userTurnId: "u", userSeq: 1, assistantTurnId: "a", assistantSeq: 2 }).kind).toBe("turn");
    expect(interpretEvent({ type: "fedlify.turn", data: { userTurnId: "u", assistantTurnId: "a" } }).kind).toBe("turn");
    expect(interpretEvent({ type: "fedlify.turn" }).kind).toBe("ignore");
    expect(interpretEvent({ type: "fedlify.questions", payload: { round: 1, questions: [] } }).kind).toBe("questions");
    expect(interpretEvent({ type: "fedlify.questions", payload: {} }).kind).toBe("ignore");
    expect(interpretEvent({ type: "fedlify.plan", plan: { id: "p1" } }).kind).toBe("plan");
    const parser = createSseParser();
    const events = parser.push(`data: ${JSON.stringify({ type: "fedlify.plan", plan: { id: "p1" } })}\n\n`);
    expect(events.map((e) => e.kind)).toEqual(["plan"]);
  });
});

describe("questions card state", () => {
  it("preselects the recommended option and builds answers", () => {
    const question = q();
    const draft = initialDraft([question]);
    expect(canSubmitAnswers([question], draft)).toBe(true);
    expect(toAnswers([question], draft)).toEqual({ q1: "b" });
    expect(toAnswers([question], selectOption(draft, question, "a"))).toEqual({ q1: "a" });
  });

  it("'Other' text replaces the selection in single choice and is added in multi choice", () => {
    const single = q();
    const typed = setOther(initialDraft([single]), single, "custom");
    expect(toAnswers([single], typed)).toEqual({ q1: "custom" });
    expect(toAnswers([single], selectOption(typed, single, "a"))).toEqual({ q1: "a" });
    const multi = q({ multi: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    let draft = initialDraft([multi]);
    expect(canSubmitAnswers([multi], draft)).toBe(false);
    draft = selectOption(selectOption(draft, multi, "a"), multi, "b");
    draft = selectOption(draft, multi, "a");
    draft = setOther(draft, multi, "x");
    expect(toAnswers([multi], draft)).toEqual({ q1: ["b", "x"] });
  });

  it("requires every question answered, and other text only when allowed", () => {
    const noOther = q({ allowOther: false, options: [{ id: "a", label: "A" }] });
    const draft = setOther(initialDraft([noOther]), noOther, "x");
    expect(canSubmitAnswers([noOther], draft)).toBe(false);
  });
});

describe("plan card state", () => {
  it("starts from enabled steps, toggles, and needs assumptions acknowledged", () => {
    const p = plan();
    const selected = initialApprovedSteps(p);
    expect(selected).toEqual(["s1"]);
    expect(canApprovePlan(p, selected, [])).toBe(false);
    expect(canApprovePlan(p, selected, ["as1"])).toBe(true);
    expect(canApprovePlan(p, toggleStep(selected, "s1"), ["as1"])).toBe(false);
    expect(toggleStep(selected, "s2")).toEqual(["s1", "s2"]);
    expect(canApprovePlan(plan({ status: "APPROVED" }), selected, ["as1"])).toBe(false);
  });

  it("reads a plan as stale once the head moved", () => {
    expect(effectivePlanStatus(plan(), "abc")).toBe("DRAFT");
    expect(effectivePlanStatus(plan(), "def")).toBe("STALE");
    expect(effectivePlanStatus(plan({ status: "EXECUTED" }), "def")).toBe("EXECUTED");
    expect(effectivePlanStatus(plan(), null)).toBe("DRAFT");
  });

  it("prefers saved approved steps", () => {
    expect(initialApprovedSteps(plan({ approvedStepIds: ["s2"] }))).toEqual(["s2"]);
  });
});

describe("thread selection and modes", () => {
  it("URL beats stored beats none", () => {
    expect(pickInitialThread("u", "s")).toBe("u");
    expect(pickInitialThread(null, "s")).toBe("s");
    expect(pickInitialThread(" ", null)).toBeNull();
  });

  it("edits only the thread param in the query string", () => {
    expect(withThreadParam("?project=p1", "t1")).toBe("?project=p1&thread=t1");
    expect(withThreadParam("?project=p1&thread=t1", "t2")).toBe("?project=p1&thread=t2");
    expect(withThreadParam("?project=p1&thread=t1", null)).toBe("?project=p1");
    expect(withThreadParam("?thread=t1", null)).toBe("");
  });

  it("maps panel modes to turn modes: agent plans first, edit is the direct path", () => {
    expect(turnModeFor("ask")).toBe("ask");
    expect(turnModeFor("plan")).toBe("plan");
    expect(turnModeFor("agent")).toBe("plan");
    expect(turnModeFor("edit")).toBeNull();
  });

  it("treats flag-off style failures as unavailable", () => {
    expect(threadsUnavailable(failureFrom(404, { error: { code: "not_found" } }))).toBe(true);
    expect(threadsUnavailable(failureFrom(409, { error: { code: "threads_disabled" } }))).toBe(true);
    expect(threadsUnavailable(failureFrom(500, null))).toBe(false);
  });
});

import { storedUserTurn } from "@/lib/agent-thread-client";

describe("storedUserTurn", () => {
  const turn = (seq: number, content: string) => ({ seq, role: "USER", kind: "MESSAGE", content }) as never;
  it("finds a stored copy of the message sent after the given seq only", () => {
    expect(storedUserTurn({ turns: [turn(1, "hi"), turn(3, "hi")] }, "hi", 2)).toBe(true);
    expect(storedUserTurn({ turns: [turn(1, "hi")] }, "hi", 1)).toBe(false);
    expect(storedUserTurn(null, "hi", 0)).toBe(false);
  });
});
