import { describe, expect, it } from "vitest";
import type { PlanQuestion } from "@/lib/agent-thread-types";
import {
  acceptAllLine,
  answerTextFor,
  confirmState,
  confirmedLine,
  draftResultLine,
  filterCounts,
  filterItems,
  nextNeedingId,
  questionsStage,
  groupByCategory,
  isDone,
  progressLine,
  QUESTION_STATUS_VIEW,
  answeredByLine,
  nothingToAskLine,
  originLabel,
  questionLabel,
  rowActions,
  truncateAnswer
} from "@/lib/study-questions-client";

const item = (id: string, status: string, category = "C1") => ({ id, status: status as never, category, categoryName: `Name ${category}` });

describe("study questions client helpers", () => {
  it("uses plain status words", () => {
    expect(QUESTION_STATUS_VIEW.SUGGESTED.label).toBe("Suggested: check it");
    expect(QUESTION_STATUS_VIEW.CONFLICT.label).toBe("Conflict: please decide");
    expect(QUESTION_STATUS_VIEW.UNKNOWN.label).toBe("Not decided");
    expect(isDone("ASSUMED")).toBe(true);
    expect(isDone("SUGGESTED")).toBe(false);
  });

  it("filters and groups", () => {
    const items = [item("R01", "ANSWERED"), item("R02", "SUGGESTED"), item("R04", "MISSING", "C2")];
    expect(filterItems(items, "needs").map((i) => i.id)).toEqual(["R02", "R04"]);
    expect(filterItems(items, "answered").map((i) => i.id)).toEqual(["R01"]);
    expect(filterItems(items, "all")).toHaveLength(3);
    expect(groupByCategory(items).map((g) => [g.category, g.items.length])).toEqual([["C1", 2], ["C2", 1]]);
  });

  it("writes the sentences", () => {
    expect(progressLine(21, 29)).toBe("21 of 29 answered");
    expect(draftResultLine({ suggested: 14, unknown: 12, conflicts: 3, unchanged: 0 })).toBe("The assistant suggested 14 answers, could not find 12, and found 3 that disagree.");
    expect(draftResultLine({ suggested: 1, unknown: 0, conflicts: 1, unchanged: 2 })).toContain("found 1 that disagrees");
    expect(draftResultLine({ suggested: 1, unknown: 0, conflicts: 1, unchanged: 2 })).toContain("2 answers you already gave or marked were left as they are");
    expect(acceptAllLine(3)).toContain("Accept 3 suggestions");
    expect(acceptAllLine(1)).toContain("Accept 1 suggestion?");
  });

  it("says who answered, where a suggestion came from, and what is waiting", () => {
    expect(answeredByLine({ status: "ANSWERED", confirmedByName: null, confirmedAt: null, sourceNote: null })).toBe("Earlier answer (not checked)");
    expect(answeredByLine({ status: "ANSWERED", confirmedByName: "Dana", confirmedAt: "2026-11-12T10:00:00Z", sourceNote: "From your description" })).toMatch(/^Accepted from the assistant by Dana/);
    expect(answeredByLine({ status: "ANSWERED", confirmedByName: "Dana", confirmedAt: "2026-11-12T10:00:00Z", sourceNote: null })).toMatch(/^Answered by Dana/);
    expect(answeredByLine({ status: "SUGGESTED", confirmedByName: null, confirmedAt: null, sourceNote: null })).toBeNull();
    expect(originLabel({ status: "SUGGESTED", evidenceClass: "fact", sourceNote: "x" })).toBe("From your text");
    expect(originLabel({ status: "SUGGESTED", evidenceClass: "assumption", sourceNote: "x" })).toBe("Assistant's guess");
    expect(nothingToAskLine({ suggested: 2 })).toMatch(/^2 suggestions are waiting/);
    expect(nothingToAskLine({ suggested: 0 })).toMatch(/^Nothing is open/);
    const items = [{ id: "R01" as const, category: "C1", categoryName: "Purpose" }, { id: "R02" as const, category: "C1", categoryName: "Purpose" }];
    expect(questionLabel(items, "R02")).toBe("Purpose, question 2");
    expect(progressLine(26, 29, 3)).toBe("23 answered and 3 assumed, out of 29");
    expect(acceptAllLine(3, 1)).toContain("2 are from your text and 1 is a guess");
  });

  it("truncates long answers", () => {
    expect(truncateAnswer("short")).toEqual({ text: "short", truncated: false });
    const long = truncateAnswer("x".repeat(400), 100);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(101);
  });

  it("offers the right row actions", () => {
    expect(rowActions("SUGGESTED", true)).toMatchObject({ accept: true, assume: true, unknown: true });
    expect(rowActions("ANSWERED", true).accept).toBe(false);
    expect(rowActions("UNKNOWN", false)).toMatchObject({ assume: false, unknown: false });
    expect(rowActions("ASSUMED", true).assume).toBe(false);
  });

  it("turns card answers into text", () => {
    const q: PlanQuestion = { id: "R05", text: "?", multi: false, allowOther: true, options: [{ id: "o1", label: "The sponsor" }, { id: "o2", label: "Each site" }] };
    expect(answerTextFor(q, "o2")).toBe("Each site");
    expect(answerTextFor(q, "  Shared by both ")).toBe("Shared by both");
    expect(answerTextFor(q, undefined)).toBe("");
  });

  it("enables confirm only when nothing needs the person", () => {
    expect(confirmState({ total: 29, answered: 20, assumed: 2 }, true)).toEqual({ enabled: false, reason: "7 questions still need you." });
    expect(confirmState({ total: 29, answered: 28, assumed: 0 }, true).reason).toBe("1 question still needs you.");
    expect(confirmState({ total: 29, answered: 27, assumed: 2 }, true)).toEqual({ enabled: true, reason: null });
    expect(confirmState({ total: 29, answered: 29, assumed: 0 }, false).enabled).toBe(false);
    expect(confirmedLine("Dana Lee", "2026-11-14T10:00:00Z")).toMatch(/^Confirmed by Dana Lee on /);
  });
});

describe("study questions navigation", () => {
  const items = [item("R01", "ANSWERED"), item("R02", "MISSING"), item("R03", "SUGGESTED"), item("R04", "CONFLICT", "C2"), item("R05", "ASSUMED", "C2")];

  it("filters suggestions to check and counts each filter", () => {
    expect(filterItems(items, "check").map((i) => i.id)).toEqual(["R03"]);
    expect(filterCounts(items)).toEqual({ all: 5, needs: 3, check: 1, answered: 2 });
  });

  it("goes to a disagreement first, then a suggestion, then an open question", () => {
    expect(nextNeedingId(items)).toBe("R04");
    const noConflict = items.map((i) => (i.id === "R04" ? item("R04", "ANSWERED", "C2") : i));
    expect(nextNeedingId(noConflict)).toBe("R03");
    expect(nextNeedingId(noConflict, "R03")).toBe("R02");
    expect(nextNeedingId([item("R01", "ANSWERED")])).toBeNull();
  });

  it("names the part of the work that comes next", () => {
    expect(questionsStage({ total: 29, answered: 0, assumed: 0, suggested: 0 }, false)).toBe("describe");
    expect(questionsStage({ total: 29, answered: 3, assumed: 0, suggested: 4 }, false)).toBe("check");
    expect(questionsStage({ total: 29, answered: 27, assumed: 2, suggested: 0 }, false)).toBe("confirm");
    expect(questionsStage({ total: 29, answered: 29, assumed: 0, suggested: 0 }, true)).toBe("done");
  });
});
