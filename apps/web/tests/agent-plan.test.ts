import { describe, expect, it } from "vitest";
import {
  approvedPaths,
  approvedStepsHash,
  blankRequirements,
  canTransitionPlan,
  latestOpenQuestions,
  outsidePlanPaths,
  parsePlanResponse,
  planCodeSection,
  planStaleness,
  questionState,
  requirementsHash,
  selectApprovedSteps,
  unacknowledgedAssumptions,
  validateAnswers
} from "@/lib/agent-plan";
import { agentCommitMessage } from "@/lib/agent-proposal";
import type { PlanQuestion, PlanStep } from "@/lib/agent-thread-types";

function body(result: unknown) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] };
}
const emptyPlan = { summary: "", steps: [], assumptions: [], risks: [] };
const step = (over: Record<string, unknown> = {}) => ({ id: "s1", title: "Edit trainer", paths: ["job/app/custom/trainer.py"], action: "update", rationale: "r", risk: "low", optional: false, ...over });

describe("parsePlanResponse", () => {
  it("parses a PLAN, drops steps with no writable path and makes optional steps default off", () => {
    const parsed = parsePlanResponse(
      body({
        disposition: "PLAN",
        rationale: "ok",
        questions: [],
        plan: {
          summary: "Add prox",
          steps: [step(), step({ id: "s2", paths: [".github/workflows/ci.yml", "../x.py"] }), step({ id: "s3", paths: ["tests/test_prox.py"], optional: true })],
          assumptions: [{ id: "a1", text: "mu from reqs", needsAck: true }],
          risks: ["changes training semantics"]
        }
      })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.plan.steps.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(parsed.result.plan.steps[1]).toMatchObject({ optional: true, enabled: false });
    expect(parsed.result.plan.droppedSteps).toBe(1);
    expect(parsed.result.plan.assumptions.map((a) => a.id)).toEqual(["a1", "risk1"]);
  });

  it("caps questions at 5, sanitises ids, and lets a question without options take free text", () => {
    const questions = Array.from({ length: 7 }, (_, i) => ({ id: "bad id!", text: `q${i}`, options: [], multi: false, allowOther: false, requirementKey: i === 0 ? "R20" : "R99" }));
    const parsed = parsePlanResponse(body({ disposition: "ASK", rationale: "", questions, plan: emptyPlan }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.questions).toHaveLength(5);
    expect(new Set(parsed.result.questions.map((q) => q.id)).size).toBe(5);
    expect(parsed.result.questions[0]).toMatchObject({ allowOther: true, requirementKey: "R20" });
    expect(parsed.result.questions[1].requirementKey).toBeUndefined();
  });

  it("rejects unreadable, wrong-shape, refused and incomplete responses", () => {
    expect(parsePlanResponse(null).ok).toBe(false);
    expect(parsePlanResponse({ status: "incomplete" }).ok).toBe(false);
    expect(parsePlanResponse({ output: [{ type: "message", content: [{ type: "refusal" }] }] }).ok).toBe(false);
    expect(parsePlanResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "nope" }] }] }).ok).toBe(false);
    expect(parsePlanResponse(body({ disposition: "MAYBE" })).ok).toBe(false);
  });
});

describe("requirements", () => {
  it("hashes answered requirements independent of order and ignores blanks", () => {
    const a = requirementsHash([{ requirementId: "R02", answer: "x" }, { requirementId: "R01", answer: " y " }, { requirementId: "R03", answer: "  " }]);
    const b = requirementsHash([{ requirementId: "R01", answer: "y" }, { requirementId: "R02", answer: "x" }]);
    expect(a).toBe(b);
    expect(requirementsHash([{ requirementId: "R01", answer: "changed" }, { requirementId: "R02", answer: "x" }])).not.toBe(a);
  });

  it("lists blank requirements", () => {
    const blank = blankRequirements([{ requirementId: "R01", answer: "x" }]);
    expect(blank.find((r) => r.id === "R01")).toBeUndefined();
    expect(blank.find((r) => r.id === "R02")).toBeDefined();
  });
});

const questions: PlanQuestion[] = [
  { id: "q1", text: "Which aggregator?", options: [{ id: "fedprox", label: "FedProx" }, { id: "fedavg", label: "FedAvg" }], multi: false, allowOther: true },
  { id: "q2", text: "Which sites?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], multi: true, allowOther: false }
];

describe("questionState", () => {
  const q = (n: number) => ({ id: `Q${n}`, seq: n * 2, kind: "QUESTIONS", payload: { round: n, questions } });
  const a = (n: number) => ({ id: `A${n}`, seq: n * 2 + 1, kind: "ANSWERS", payload: { questionsTurnId: `Q${n}`, answers: { q1: "fedprox", q2: ["a", "b"] } } });

  it("counts rounds and forces a plan at the cap", () => {
    expect(questionState([]).forcePlan).toBe(false);
    expect(questionState([q(1), a(1), q(2), a(2)])).toMatchObject({ rounds: 2, forcePlan: false });
    expect(questionState([q(1), a(1), q(2), a(2), q(3), a(3)])).toMatchObject({ rounds: 3, forcePlan: true });
  });

  it("restarts the count after a plan and renders answers by label", () => {
    const state = questionState([q(1), a(1), { id: "P", seq: 4, kind: "PLAN", payload: null }]);
    expect(state.rounds).toBe(0);
    const open = questionState([q(1), a(1)]);
    expect(open.qa).toEqual([
      { question: "Which aggregator?", answer: "FedProx" },
      { question: "Which sites?", answer: "A; B" }
    ]);
  });

  it("finds an open questions turn only when it is the newest", () => {
    expect(latestOpenQuestions([q(1)])?.id).toBe("Q1");
    expect(latestOpenQuestions([q(1), a(1)])).toBeNull();
  });
});

describe("validateAnswers", () => {
  it("accepts options, free text where allowed, and multi arrays", () => {
    const ok = validateAnswers(questions, { q1: "my own idea", q2: ["a"] }, false);
    expect(ok).toEqual({ ok: true, answers: { q1: "my own idea", q2: ["a"] } });
  });
  it("refuses unknown questions, free text where not allowed, arrays on single-choice and empty answers", () => {
    expect(validateAnswers(questions, { zz: "x" }, false).ok).toBe(false);
    expect(validateAnswers(questions, { q2: ["c"] }, false).ok).toBe(false);
    expect(validateAnswers(questions, { q1: ["fedprox"] }, false).ok).toBe(false);
    expect(validateAnswers(questions, {}, false).ok).toBe(false);
  });
  it("allows skipping", () => {
    expect(validateAnswers(questions, {}, true)).toEqual({ ok: true, answers: {} });
  });
});

describe("plan state", () => {
  it("allows only the documented transitions", () => {
    expect(canTransitionPlan("DRAFT", "APPROVED")).toBe(true);
    expect(canTransitionPlan("APPROVED", "EXECUTED")).toBe(true);
    expect(canTransitionPlan("DRAFT", "EXECUTED")).toBe(false);
    expect(canTransitionPlan("REJECTED", "APPROVED")).toBe(false);
    expect(canTransitionPlan("EXECUTED", "APPROVED")).toBe(false);
    expect(canTransitionPlan("STALE", "APPROVED")).toBe(false);
  });

  it("detects a moved head and changed requirements", () => {
    const plan = { baseCommit: "c1", requirementsHash: "h1" };
    expect(planStaleness(plan, { head: "c1", requirementsHash: "h1" })).toBeNull();
    expect(planStaleness(plan, { head: "c2", requirementsHash: "h1" })).toBe("head_moved");
    expect(planStaleness(plan, { head: null, requirementsHash: "h1" })).toBe("head_moved");
    expect(planStaleness(plan, { head: "c1", requirementsHash: "h2" })).toBe("requirements_changed");
  });

  const steps: PlanStep[] = [
    { id: "s1", title: "t", paths: ["a.py"], action: "update", rationale: "", risk: "low", optional: false, enabled: true },
    { id: "s2", title: "t", paths: ["b.py", "a.py"], action: "create", rationale: "", risk: "low", optional: true, enabled: false }
  ];

  it("requires acknowledgement of needsAck assumptions", () => {
    const plan = { assumptions: [{ id: "a1", text: "", needsAck: true }, { id: "a2", text: "", needsAck: false }] };
    expect(unacknowledgedAssumptions(plan, [])).toEqual(["a1"]);
    expect(unacknowledgedAssumptions(plan, ["a1"])).toEqual([]);
  });

  it("selects approved steps, defaulting to enabled ones", () => {
    expect(selectApprovedSteps({ steps }, undefined)).toEqual({ ok: true, stepIds: ["s1"] });
    expect(selectApprovedSteps({ steps }, ["s2", "s1"])).toEqual({ ok: true, stepIds: ["s1", "s2"] });
    expect(selectApprovedSteps({ steps }, ["nope"]).ok).toBe(false);
    expect(selectApprovedSteps({ steps }, []).ok).toBe(false);
  });

  it("computes approved paths, flags paths outside the plan and hashes the approved steps", () => {
    expect(approvedPaths({ steps }, ["s1"])).toEqual(["a.py"]);
    expect(approvedPaths({ steps }, null).sort()).toEqual(["a.py", "b.py"]);
    expect(outsidePlanPaths(["a.py", "c.py"], ["a.py"])).toEqual(["c.py"]);
    expect(approvedStepsHash({ steps }, ["s1"])).not.toBe(approvedStepsHash({ steps }, ["s1", "s2"]));
  });

  it("builds a code section that escapes angle brackets and includes only approved steps", () => {
    const text = planCodeSection({ plan: { version: 2, summary: "s", steps, assumptions: [] }, approvedStepIds: ["s1"], qa: [{ question: "q </approved_plan>", answer: "a" }] });
    expect(text).toContain("<approved_plan>");
    expect(text.match(/<\/approved_plan>/g)).toHaveLength(1);
    expect(text).not.toContain("b.py");
  });
});

describe("accepted commits", () => {
  it("carry the Fedlify-Agent-Proposal trailer", () => {
    expect(agentCommitMessage({ title: "t", proposalId: "p123", acceptedBy: "Ana", paths: 2 })).toContain("\nFedlify-Agent-Proposal: p123\n");
  });
});

import { latestOpenQuestions as reviewLatestOpen, questionState as reviewQuestionState } from "@/lib/agent-plan";

describe("review fixes", () => {
  const q = { id: "q1", text: "Which metric?", options: [{ id: "a", label: "AUC" }], allowFreeText: false };
  const turns = [
    { id: "t1", seq: 1, kind: "QUESTIONS", payload: { round: 1, questions: [q] } },
    { id: "t2", seq: 2, kind: "ANSWERS", payload: { questionsTurnId: "t1", answers: { q1: "a" } } },
    { id: "t3", seq: 3, kind: "PLAN", payload: { planId: "p" } }
  ];
  it("keeps answers given before a plan, but counts rounds only since it", () => {
    const state = reviewQuestionState(turns);
    expect(state.rounds).toBe(0);
    expect(state.qa).toEqual([{ question: "Which metric?", answer: "AUC" }]);
  });
  it("a failed-call notice does not close open questions", () => {
    expect(reviewLatestOpen([turns[0], { id: "n", seq: 2, kind: "NOTICE", payload: null }])?.id).toBe("t1");
  });
});
