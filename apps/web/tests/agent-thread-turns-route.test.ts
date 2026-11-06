import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  fetch: vi.fn(),
  repo: vi.fn(),
  prisma: {
    study: { findUnique: vi.fn() },
    requirementResponse: { findMany: vi.fn() },
    studySite: { findMany: vi.fn() },
    pipelineProject: { findUnique: vi.fn() },
    agentTurn: { findFirst: vi.fn(), findMany: vi.fn() },
    agentPlan: { updateMany: vi.fn() }
  },
  store: {
    getThreadInProject: vi.fn(),
    appendTurn: vi.fn(),
    finalizeTurn: vi.fn(),
    linkTurn: vi.fn(),
    loadHistory: vi.fn(),
    createPlan: vi.fn(),
    setThreadMode: vi.fn()
  }
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async () => true, assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true, acquireSlot: () => () => undefined }));
vi.mock("@/lib/diagnostics-access", () => ({ loadDiagnosticsForMessage: async () => null }));
vi.mock("@/lib/project-repo", () => ({ loadProjectRepo: (...a: unknown[]) => h.repo(...a) }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { POST as turnsPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/turns/route";
import { POST as answersPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/answers/route";
import { POST as messagesPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/messages/route";
import { FORBIDDEN_AUDIT_KEYS } from "@/lib/agent-thread-types";

const turnsPost = async (...args: Parameters<typeof turnsPostRaw>) => (await turnsPostRaw(...args)) as Response;
const answersPost = async (...args: Parameters<typeof answersPostRaw>) => (await answersPostRaw(...args)) as Response;
const messagesPost = async (...args: Parameters<typeof messagesPostRaw>) => (await messagesPostRaw(...args)) as Response;

const now = new Date("2026-11-11T10:00:00Z");
const thread = (over: Record<string, unknown> = {}) => ({
  id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "ask", turnCount: 0, lastTurnAt: now, createdAt: now,
  createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over
});
let seq = 0;
const turnRow = (over: Record<string, unknown> = {}) => ({
  id: `turn${++seq}`, threadId: "t1", seq, role: "USER", kind: "MESSAGE", content: "", payload: null, status: "done", actorUserId: null, model: null, promptVersion: null,
  contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null, createdAt: now, ...over
});
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1", ...extra }) }) as never;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://x${url}`, { method: "POST", body: JSON.stringify(body), headers }) as never;
const turnBody = (over: Record<string, unknown> = {}) => ({ message: "add FedProx with mu=0.01", mode: "ask", clientTurnId: "c-1", ...over });

function planBody(result: unknown) {
  return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }) };
}
const emptyPlan = { summary: "", steps: [], assumptions: [], risks: [] };
const question = { id: "q1", text: "Which aggregator?", options: [{ id: "fedprox", label: "FedProx", recommended: true }], multi: false, allowOther: false, requirementKey: null };

function sseBody(events: unknown[], options: { hang?: boolean } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      if (!options.hang) controller.close();
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(undefined);
  seq = 0;
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal("fetch", h.fetch);
  h.repo.mockResolvedValue({ ok: true, project: { id: "p1", study: { orgId: "o1" } }, commit: "c1", files: [{ path: "client.py", content: "x" }] });
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ id: "p1", studyId: "s1", study: { id: "s1", orgId: "o1" } });
  h.prisma.study.findUnique.mockResolvedValue({ id: "s1" });
  h.prisma.requirementResponse.findMany.mockResolvedValue([]);
  h.prisma.studySite.findMany.mockResolvedValue([]);
  h.prisma.agentTurn.findFirst.mockResolvedValue(null);
  h.prisma.agentTurn.findMany.mockResolvedValue([]);
  h.store.getThreadInProject.mockResolvedValue(thread());
  h.store.appendTurn.mockImplementation(async (input: Record<string, unknown>) => ({ turn: turnRow({ ...input, role: input.role }), duplicate: false }));
  h.store.finalizeTurn.mockResolvedValue(true);
  h.store.linkTurn.mockResolvedValue({});
  h.store.loadHistory.mockResolvedValue([{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }]);
  h.store.setThreadMode.mockResolvedValue({});
  h.store.createPlan.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "plan1", threadId: "t1", version: 1, approvedStepIds: null, decidedById: null, decidedAt: null, createdAt: now, status: "DRAFT", ...input
  }));
});

function auditText() {
  return JSON.stringify(h.audit.mock.calls);
}
function auditKeys() {
  return h.audit.mock.calls.flatMap((call) => Object.keys((call[0] as { metadata: object }).metadata));
}

describe("turns route: ask", () => {
  it("stores the user and assistant turns, streams, and finalizes the reply as done", async () => {
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.output_text.delta", delta: "Hello " }, { type: "response.output_text.delta", delta: "world" }, { type: "response.completed" }]) });
    const res = await turnsPost(post("/t", turnBody()), params());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("fedlify.turn");
    expect(text).toContain("fedlify.done");
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ role: "USER", content: "add FedProx with mu=0.01", clientTurnId: "c-1", actorUserId: "u1" });
    expect(h.store.appendTurn.mock.calls[1][0]).toMatchObject({ role: "ASSISTANT", status: "streaming" });
    expect(h.store.finalizeTurn).toHaveBeenCalledWith(expect.any(String), { status: "done", content: "Hello world" });
    // The model sees stored history, not anything from the client, and the call stays unstored upstream.
    const sent = JSON.parse(h.fetch.mock.calls[0][1].body);
    expect(sent.store).toBe(false);
    expect(JSON.stringify(sent.input)).toContain("earlier");
    expect(h.store.loadHistory.mock.calls[0][1]).toMatchObject({ beforeSeq: 1 });
  });

  it("does not call the model when the user turn cannot be stored", async () => {
    h.store.appendTurn.mockRejectedValue(new Error("db down"));
    const res = await turnsPost(post("/t", turnBody()), params());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("persist_failed");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps partial text as stopped when the stream is cut", async () => {
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.output_text.delta", delta: "partial" }]) });
    const controller = new AbortController();
    const request = new Request("http://x/t", { method: "POST", body: JSON.stringify(turnBody()), signal: controller.signal });
    controller.abort();
    // The stream ends without response.completed: that is an interrupted reply.
    const res = await turnsPost(request as never, params());
    const text = await res.text();
    expect(text).toContain("fedlify.error");
    expect(h.store.finalizeTurn).toHaveBeenCalledWith(expect.any(String), { status: "stopped", content: "partial" });
  });

  it("marks the reply error (not stopped) when the stream ends early without an abort", async () => {
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.output_text.delta", delta: "partial" }]) });
    await (await turnsPost(post("/t", turnBody()), params())).text();
    expect(h.store.finalizeTurn).toHaveBeenCalledWith(expect.any(String), { status: "error", content: "partial" });
  });

  it("returns the stored turn for a repeated clientTurnId without calling the model", async () => {
    h.prisma.agentTurn.findFirst.mockResolvedValue(turnRow({ clientTurnId: "c-1" }));
    const res = await turnsPost(post("/t", turnBody()), params());
    expect((await res.json()).duplicate).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses read-only viewers, archived threads, and other projects' threads", async () => {
    h.store.getThreadInProject.mockResolvedValue(thread({ createdById: "u2" }));
    // u1 is neither author nor manager here (canAccessStudy mock grants all, so manager): read-only
    const res = await turnsPost(post("/t", turnBody()), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("thread_read_only");
    h.store.getThreadInProject.mockResolvedValue(thread({ status: "ARCHIVED" }));
    expect((await turnsPost(post("/t", turnBody()), params())).status).toBe(409);
    h.store.getThreadInProject.mockResolvedValue(null);
    expect((await turnsPost(post("/t", turnBody()), params())).status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("never puts message text or other forbidden keys in the audit metadata", async () => {
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.completed" }]) });
    await (await turnsPost(post("/t", turnBody()), params())).text();
    expect(h.audit).toHaveBeenCalled();
    expect(auditText()).not.toContain("FedProx");
    expect(auditKeys().filter((key) => (FORBIDDEN_AUDIT_KEYS as readonly string[]).includes(key))).toEqual([]);
  });

  it("rejects sensitive file paths and bad bodies", async () => {
    expect((await turnsPost(post("/t", turnBody({ filePath: ".env" })), params())).status).toBe(400);
    expect((await turnsPost(post("/t", { message: "x", mode: "agent", clientTurnId: "c" }), params())).status).toBe(400);
    expect((await turnsPost(post("/t", { message: "x", mode: "ask" }), params())).status).toBe(400);
  });
});

describe("messages route with a thread", () => {
  it("persists through the thread when threadId is given and ignores client history", async () => {
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.completed" }]) });
    const res = await messagesPost(post("/m", { message: "hi", threadId: "t1", clientTurnId: "c9", history: [{ role: "user", content: "FORGED" }] }), params());
    expect(res.status).toBe(200);
    await res.text();
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ role: "USER", content: "hi" });
    expect(JSON.stringify(JSON.parse(h.fetch.mock.calls[0][1].body).input)).not.toContain("FORGED");
  });

  it("is 404 threads_disabled with a threadId when the flag is off", async () => {
    process.env.AGENT_THREADS_ENABLED = "false";
    const res = await messagesPost(post("/m", { message: "hi", threadId: "t1" }), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("threads_disabled");
  });

  it("without threadId stays stateless", async () => {
    process.env.AGENT_THREADS_ENABLED = "false";
    h.fetch.mockResolvedValue({ ok: true, body: sseBody([{ type: "response.completed" }]) });
    await (await messagesPost(post("/m", { message: "hi" }), params())).text();
    expect(h.store.appendTurn).not.toHaveBeenCalled();
  });
});

describe("turns route: plan", () => {
  const planMode = (over: Record<string, unknown> = {}) => turnBody({ mode: "plan", ...over });

  it("returns questions as a QUESTIONS turn, audits counts only, and does not write a plan", async () => {
    h.fetch.mockResolvedValue(planBody({ disposition: "ASK", rationale: "Need a decision", questions: [question], plan: emptyPlan }));
    const res = await turnsPost(post("/t", planMode()), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions.payload).toMatchObject({ round: 1 });
    expect(h.store.appendTurn.mock.calls.map((c) => c[0].kind ?? "MESSAGE")).toEqual(["MESSAGE", "QUESTIONS"]);
    expect(h.store.createPlan).not.toHaveBeenCalled();
    expect(auditText()).not.toContain("Which aggregator");
    expect(h.audit.mock.calls[0][0]).toMatchObject({ action: "pipeline_project.agent_plan_questions", metadata: { round: 1, questionCount: 1 } });
  });

  it("creates a DRAFT plan with the base commit and requirements hash, and a PLAN turn", async () => {
    h.fetch.mockResolvedValue(
      planBody({
        disposition: "PLAN",
        rationale: "Do it",
        questions: [],
        plan: { summary: "Add prox", steps: [{ id: "s1", title: "Edit trainer", paths: ["job/app/custom/trainer.py"], action: "update", rationale: "r", risk: "low", optional: false }], assumptions: [], risks: [] }
      })
    );
    const res = await turnsPost(post("/t", planMode()), params());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.plan.plan).toMatchObject({ version: 1, baseCommit: "c1", status: "DRAFT" });
    expect(h.store.createPlan.mock.calls[0][0]).toMatchObject({ baseCommit: "c1", threadId: "t1" });
    expect(h.store.createPlan.mock.calls[0][0].requirementsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.store.appendTurn.mock.calls[1][0]).toMatchObject({ kind: "PLAN", planId: "plan1" });
    expect(h.audit.mock.calls[0][0].action).toBe("pipeline_project.agent_plan");
    expect(auditText()).not.toContain("Add prox");
  });

  it("emits SSE events when the client accepts event-stream", async () => {
    h.fetch.mockResolvedValue(planBody({ disposition: "ASK", rationale: "", questions: [question], plan: emptyPlan }));
    const res = await turnsPost(post("/t", planMode(), { accept: "text/event-stream" }), params());
    const text = await res.text();
    expect(text).toContain("fedlify.turn");
    expect(text).toContain("fedlify.questions");
    expect(text).toContain("fedlify.done");
  });

  it("stores a NOTICE and an audit entry, and no plan, when the model JSON is invalid", async () => {
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }) });
    const res = await turnsPost(post("/t", planMode()), params());
    expect(res.status).toBe(502);
    expect(h.store.appendTurn.mock.calls[1][0]).toMatchObject({ kind: "NOTICE", role: "ASSISTANT" });
    expect(h.store.createPlan).not.toHaveBeenCalled();
    expect(h.audit.mock.calls[0][0].action).toBe("pipeline_project.agent_plan_invalid");
  });

  it("forces a plan after three question rounds and refuses a fourth ASK", async () => {
    const q = (n: number) => ({ id: `Q${n}`, seq: n * 2, kind: "QUESTIONS", payload: { round: n, questions: [question] } });
    h.prisma.agentTurn.findMany.mockResolvedValue([q(1), q(2), q(3)]);
    h.fetch.mockResolvedValue(planBody({ disposition: "ASK", rationale: "", questions: [question], plan: emptyPlan }));
    const res = await turnsPost(post("/t", planMode()), params());
    expect(res.status).toBe(502);
    expect(JSON.stringify(JSON.parse(h.fetch.mock.calls[0][1].body).input)).toContain("question limit is reached");
    expect(h.store.appendTurn.mock.calls.some((c) => c[0].kind === "QUESTIONS")).toBe(false);
  });

  it("does not call the model when the user turn cannot be stored", async () => {
    h.store.appendTurn.mockRejectedValue(new Error("db down"));
    expect((await turnsPost(post("/t", planMode()), params())).status).toBe(500);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("answers route", () => {
  const open = { id: "Q1", seq: 2, kind: "QUESTIONS", payload: { round: 1, questions: [question] } };

  it("stores the answers, re-triages and returns a plan", async () => {
    const answered = { id: "A1", seq: 3, kind: "ANSWERS", payload: { questionsTurnId: "Q1", answers: { q1: "fedprox" } } };
    h.prisma.agentTurn.findMany.mockResolvedValueOnce([open]).mockResolvedValue([open, answered]);
    h.prisma.agentTurn.findFirst.mockResolvedValue(null);
    h.fetch.mockResolvedValue(planBody({ disposition: "PLAN", rationale: "", questions: [], plan: { summary: "s", steps: [{ id: "s1", title: "t", paths: ["client.py"], action: "update", rationale: "", risk: "low", optional: false }], assumptions: [], risks: [] } }));
    const res = await answersPost(post("/a", { turnId: "Q1", answers: { q1: "fedprox" } }), params());
    expect(res.status).toBe(201);
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ kind: "ANSWERS", clientTurnId: "answers:Q1", payload: { questionsTurnId: "Q1", answers: { q1: "fedprox" } } });
    expect(JSON.stringify(JSON.parse(h.fetch.mock.calls[0][1].body).input)).toContain("FedProx");
    expect(auditText()).not.toContain("fedprox");
  });

  it("refuses answers that were not asked, and questions that are no longer open", async () => {
    h.prisma.agentTurn.findMany.mockResolvedValue([open]);
    expect((await answersPost(post("/a", { turnId: "Q1", answers: { q1: "made-up" } }), params())).status).toBe(400);
    expect((await answersPost(post("/a", { turnId: "OLD", answers: { q1: "fedprox" } }), params())).status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
