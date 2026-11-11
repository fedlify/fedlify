import { afterEach, describe, expect, it, vi } from "vitest";
import { contractSpec, evaluateAssistantPolicy } from "@/lib/assistant-control";
import { activationGate, countsAsAnswered, requirementsGate } from "@/lib/governance";
import { evaluatePreflight, PREFLIGHT_NOT_TAKING_PART_PREFIX, type PreflightSite, type PreflightSnapshot } from "@/lib/preflight";
import { buildContextPack } from "@/lib/project-context";
import { REQUIREMENT_ORDER } from "@/lib/requirements-catalog";
import { studyQuestionsStrict } from "@/lib/runtime-config";
import { stopPayloadFor } from "@/lib/terms";
import { PLAIN_QUESTIONS, QUESTION_CATEGORIES, quoteAppearsIn, specificationHash } from "@/lib/study-questions";

const rows = (status: (id: string) => string | undefined) => REQUIREMENT_ORDER.map((id) => ({ requirementId: id, status: status(id) }));

afterEach(() => {
  delete process.env.STUDY_QUESTIONS_STRICT;
  vi.resetModules();
});

describe("requirementsGate", () => {
  it("counts ANSWERED, ASSUMED and older rows without a status", () => {
    expect(countsAsAnswered(undefined)).toBe(true);
    expect(countsAsAnswered(null)).toBe(true);
    expect(countsAsAnswered("ANSWERED")).toBe(true);
    expect(countsAsAnswered("ASSUMED")).toBe(true);
    expect(requirementsGate(rows(() => undefined)).allowed).toBe(true);
    expect(requirementsGate(REQUIREMENT_ORDER.map((id) => ({ requirementId: id }))).allowed).toBe(true);
    expect(requirementsGate(rows((id) => (id === "R05" ? "ASSUMED" : "ANSWERED"))).allowed).toBe(true);
  });

  it("never counts SUGGESTED, UNKNOWN or CONFLICT rows", () => {
    for (const status of ["SUGGESTED", "UNKNOWN", "CONFLICT"]) {
      const gate = requirementsGate(rows((id) => (id === "R07" ? status : "ANSWERED")));
      expect(gate.allowed).toBe(false);
      expect(gate.missing).toEqual(["R07"]);
    }
  });

  it("feeds the activation gate the same way", () => {
    const study = { requirementResponses: rows((id) => (id === "R01" ? "SUGGESTED" : "ANSWERED")) };
    expect(activationGate(study).missing).toContain("Study questions (28 of 29 answered)");
  });
});

describe("STUDY_QUESTIONS_STRICT", () => {
  it("is off by default and on only for true, 1, on or yes", () => {
    expect(studyQuestionsStrict()).toBe(false);
    for (const [value, expected] of [["true", true], ["TRUE", true], ["1", true], ["on", true], ["yes", true], ["false", false], ["", false], ["maybe", false]] as const) {
      process.env.STUDY_QUESTIONS_STRICT = value;
      expect(studyQuestionsStrict()).toBe(expected);
    }
  });

  it("loads strict progress with the confirmation, and leaves plain progress alone when off", async () => {
    const findMany = vi.fn(async () => rows(() => "ANSWERED"));
    const study = vi.fn(async () => ({ specificationConfirmedAt: null as Date | null }));
    vi.doMock("@/lib/prisma", () => ({ prisma: { requirementResponse: { findMany }, study: { findUnique: study } } }));
    const { loadQuestionProgress } = await import("@/lib/preflight-data");
    expect(await loadQuestionProgress("s1")).toEqual({ answered: 29, total: 29 });
    expect(study).not.toHaveBeenCalled();
    process.env.STUDY_QUESTIONS_STRICT = "true";
    expect(await loadQuestionProgress("s1")).toEqual({ answered: 29, total: 29, strict: true, confirmed: false });
    study.mockResolvedValue({ specificationConfirmedAt: new Date() });
    expect(await loadQuestionProgress("s1")).toMatchObject({ strict: true, confirmed: true });
    // Suggestions do not count in any mode.
    findMany.mockResolvedValue(rows((id) => (id < "R10" ? "SUGGESTED" : "ANSWERED")));
    expect((await loadQuestionProgress("s1")).answered).toBe(20);
    vi.doUnmock("@/lib/prisma");
  });
});

const site = (code: string, over: Partial<PreflightSite> = {}): PreflightSite => ({ studySiteId: `ss-${code}`, siteId: `ss-${code}`, code, name: `Hospital ${code}`, signedOff: true, connected: true, imageState: "CURRENT", ...over });
const publishSnap = (questions: PreflightSnapshot["questions"]): PreflightSnapshot => ({
  studyId: "s1",
  now: new Date("2026-11-10T12:00:00Z"),
  ethics: { status: "APPROVED", validUntil: null },
  questions,
  sites: [site("A")],
  savedCode: true,
  publishInProgress: false,
  runInProgress: false
});
const questionItem = (questions: PreflightSnapshot["questions"]) => evaluatePreflight("publish", publishSnap(questions)).items.find((i) => i.code === "study_questions")!;

describe("preflight study_questions item", () => {
  it("keeps the usual text when strict mode is off", () => {
    expect(questionItem({ answered: 29, total: 29 })).toMatchObject({ ok: true, text: "All study questions are answered" });
    expect(questionItem({ answered: 26, total: 29 })).toMatchObject({ ok: false, text: "Answer the remaining study questions (3 left)" });
    // Confirmation is not asked for when strict is off, even if the field is absent.
    expect(evaluatePreflight("publish", publishSnap({ answered: 29, total: 29 })).ok).toBe(true);
  });

  it("in strict mode says how many still need an answer, then asks for the confirmation", () => {
    expect(questionItem({ answered: 26, total: 29, strict: true, confirmed: false })).toMatchObject({ ok: false, text: "3 study questions still need an answer" });
    expect(questionItem({ answered: 28, total: 29, strict: true })).toMatchObject({ ok: false, text: "1 study question still needs an answer" });
    const unconfirmed = questionItem({ answered: 29, total: 29, strict: true, confirmed: false });
    expect(unconfirmed).toMatchObject({ ok: false, text: "Confirm the study specification" });
    expect(evaluatePreflight("publish", publishSnap({ answered: 29, total: 29, strict: true, confirmed: false })).ok).toBe(false);
    const done = questionItem({ answered: 29, total: 29, strict: true, confirmed: true });
    expect(done).toMatchObject({ ok: true, text: "The study specification is confirmed" });
    expect(evaluatePreflight("publish", publishSnap({ answered: 29, total: 29, strict: true, confirmed: true })).ok).toBe(true);
  });
});

describe("run pre-flight: sites that will not take part", () => {
  const run = (sites: PreflightSite[]) =>
    evaluatePreflight("run", {
      studyId: "s1",
      now: new Date("2026-11-10T12:00:00Z"),
      ethics: { status: "APPROVED", validUntil: null },
      questions: { answered: 0, total: 0 },
      sites,
      pipeline: { exists: true, approved: true, checksPassed: true },
      studyServer: { running: true, servesPipeline: true },
      minSites: 1
    });

  it("adds an informational item per site that is not connected, and never blocks", () => {
    const result = run([site("A"), site("B", { connected: false }), site("C", { connected: false, name: "" })]);
    const notes = result.items.filter((i) => i.code.startsWith(PREFLIGHT_NOT_TAKING_PART_PREFIX));
    expect(notes.map((i) => i.text)).toEqual(["Hospital B is not connected and will not take part in this run", "C is not connected and will not take part in this run"]);
    expect(notes.every((i) => i.ok)).toBe(true);
    // The existing "Connect the runner" items are untouched; only min_sites decides.
    expect(result.items.find((i) => i.code === "min_sites")).toMatchObject({ ok: true });
    expect(result.ok).toBe(false); // the runner items for B and C still fail, as before
    expect(result.items.filter((i) => !i.ok).every((i) => !i.code.startsWith(PREFLIGHT_NOT_TAKING_PART_PREFIX))).toBe(true);
  });

  it("adds nothing when every site is connected, when connection is unknown, or when the server cannot be asked", () => {
    expect(run([site("A"), site("B")]).items.some((i) => i.code.startsWith(PREFLIGHT_NOT_TAKING_PART_PREFIX))).toBe(false);
    expect(run([site("A", { connected: null })]).items.some((i) => i.code.startsWith(PREFLIGHT_NOT_TAKING_PART_PREFIX))).toBe(false);
    const unreachable = evaluatePreflight("run", { studyId: "s1", ethics: null, questions: { answered: 0, total: 0 }, sites: [site("A", { connected: false })], serverUnreachable: true });
    expect(unreachable.items.some((i) => i.code.startsWith(PREFLIGHT_NOT_TAKING_PART_PREFIX))).toBe(false);
  });
});

describe("project context", () => {
  it("only hands the code assistant answers a person gave", () => {
    const { pack: built } = buildContextPack({
      study: { title: "T" },
      requirementResponses: [
        { requirementId: "R01", answer: "Person answer", status: "ANSWERED" },
        { requirementId: "R02", answer: "Assumed answer", status: "ASSUMED" },
        { requirementId: "R03", answer: "Older answer" },
        { requirementId: "R04", answer: "Assistant guess", status: "SUGGESTED" },
        { requirementId: "R05", answer: "Disputed", status: "CONFLICT" },
        { requirementId: "R06", answer: "Kept text", status: "UNKNOWN" }
      ],
      sites: [],
      files: []
    });
    expect(built.requirements.map((r) => r.id)).toEqual(["R01", "R02", "R03"]);
  });
});

describe("study questions helpers", () => {
  it("has a plain question for every requirement and puts each in one of eight groups", () => {
    for (const id of REQUIREMENT_ORDER) expect(PLAIN_QUESTIONS[id]).toMatch(/\?$/);
    expect(QUESTION_CATEGORIES).toHaveLength(8);
    expect(QUESTION_CATEGORIES.flatMap((c) => c.ids).sort()).toEqual([...REQUIREMENT_ORDER].sort());
  });
  it("hashes the ordered answers and changes with any of them", () => {
    const base = REQUIREMENT_ORDER.map((id) => ({ requirementId: id, answer: "a", status: "ANSWERED" }));
    const reversed = [...base].reverse();
    expect(specificationHash(base)).toBe(specificationHash(reversed));
    expect(specificationHash(base)).not.toBe(specificationHash(base.map((r, i) => (i === 3 ? { ...r, answer: "b" } : r))));
    expect(specificationHash(base)).not.toBe(specificationHash(base.map((r, i) => (i === 3 ? { ...r, status: "ASSUMED" } : r))));
  });
  it("checks a quote against the text ignoring case and spacing", () => {
    expect(quoteAppearsIn("Three  hospitals\ntake part.", "three hospitals take part")).toBe(true);
    expect(quoteAppearsIn("Three hospitals take part.", "five hospitals")).toBe(false);
    expect(quoteAppearsIn("abc", "")).toBe(false);
    // Short or single-word quotes and pieces of words prove nothing.
    expect(quoteAppearsIn("We use patient data from three sites.", "data")).toBe(false);
    expect(quoteAppearsIn("We use patient data from three sites.", "the ")).toBe(false);
    expect(quoteAppearsIn("We use patient data from three sites.", "patient data from")).toBe(true);
    expect(quoteAppearsIn("We use patient data from three sites.", "atient data fro")).toBe(false);
  });
});

describe("stop text", () => {
  it("points to a study lead, not study owners", () => {
    expect(stopPayloadFor(["SENSITIVE_CONTENT"]).whoDecides).toBe("You decide. A study lead can help if you are unsure.");
  });
});

describe("assistant.requirements.v1 contract", () => {
  it("is its own read-only contract for the requirements mode", () => {
    expect(contractSpec("assistant.requirements.v1").allowedTools).toEqual([]);
    const contract = (name: string) => ({ name, active: true, allowedTools: [] as string[] });
    expect(evaluateAssistantPolicy({ mode: "requirements", contract: contract("assistant.requirements.v1"), requestedTools: [] }).passed).toBe(true);
    expect(evaluateAssistantPolicy({ mode: "requirements", contract: contract("assistant.plan.v1"), requestedTools: [] }).reasonCodes).toEqual(["CONTRACT_MODE_MISMATCH"]);
    expect(evaluateAssistantPolicy({ mode: "requirements", contract: contract("assistant.requirements.v1"), requestedTools: ["propose_file_changes"] }).reasonCodes).toEqual(["TOOL_OUTSIDE_CONTRACT"]);
  });
});
