import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const control = { broken: false, workItems: [] as Array<Record<string, any>>, decisions: [] as Array<Record<string, any>>, executions: [] as Array<Record<string, any>>, links: [] as Array<Record<string, any>> };
  const guard = async () => {
    if (control.broken) throw new Error("control tables unavailable");
  };
  const tx = {
    workItem: { create: async ({ data }: any) => { const row = { id: `wi${control.workItems.length + 1}`, version: 1, ...data }; control.workItems.push(row); return row; }, updateMany: async ({ where, data }: any) => { const row = control.workItems.find((item) => item.id === where.id)!; Object.assign(row, { ...data, version: row.version + 1 }); return { count: 1 }; } },
    decisionRecord: { create: async ({ data }: any) => { control.decisions.push(data); return data; } },
    quarantineRecord: { create: async ({ data }: any) => data },
    agentExecution: { findFirst: async () => null, create: async ({ data }: any) => { control.executions.push(data); return data; } }
  };
  return {
    control,
    audit: vi.fn(),
    fetch: vi.fn(),
    repo: vi.fn(),
    head: vi.fn(),
    prisma: {
      study: { findUnique: vi.fn() },
      requirementResponse: { findMany: vi.fn() },
      studySite: { findMany: vi.fn() },
      pipelineProject: { findUnique: vi.fn() },
      agentTurn: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: async ({ data, where }: any) => { await guard(); control.links.push({ ids: where.id.in, ...data }); return { count: 1 }; } },
      agentPlan: { findFirst: vi.fn(), updateMany: vi.fn() },
      agentProposal: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      skillContract: { findFirst: async ({ where }: any) => { await guard(); return { id: "sc1", name: where.name, active: true, allowedTools: where.name === "assistant.change.v1" ? ["propose_file_changes"] : [], contractHash: "h", tokenBudget: 1000, timeBudgetSeconds: 60 }; }, create: vi.fn() },
      workItem: { findFirst: async () => { await guard(); return null; }, findUnique: async ({ where }: any) => { await guard(); return control.workItems.find((item) => item.id === where.id) ?? null; } },
      $transaction: async (fn: any) => { await guard(); return fn(tx); }
    },
    store: { getThreadInProject: vi.fn(), getPlanInThread: vi.fn(), transitionPlan: vi.fn(), appendTurn: vi.fn(), finalizeTurn: vi.fn(), linkTurn: vi.fn(), loadHistory: vi.fn(), createPlan: vi.fn(), setThreadMode: vi.fn() }
  };
});

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async () => true, assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true, acquireSlot: () => () => undefined }));
vi.mock("@/lib/diagnostics-access", () => ({ loadDiagnosticsForMessage: async () => null }));
vi.mock("@/lib/project-repo", () => ({ loadProjectRepo: (...a: unknown[]) => h.repo(...a) }));
vi.mock("@/lib/agent-proposal-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-proposal-store")>()), branchHead: (...a: unknown[]) => h.head(...a) }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { POST as turnsPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/turns/route";
import { POST as proposalsPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals/route";

const turnsPost = async (...args: Parameters<typeof turnsPostRaw>) => (await turnsPostRaw(...args)) as Response;
const proposalsPost = async (...args: Parameters<typeof proposalsPostRaw>) => (await proposalsPostRaw(...args)) as Response;

const now = new Date("2026-11-13T10:00:00Z");
let seq = 0;
const thread = (over: Record<string, unknown> = {}) => ({ id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "ask", turnCount: 0, lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over });
const params = () => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1" }) }) as never;
const post = (body: unknown) => new Request("http://x/t", { method: "POST", body: JSON.stringify(body) }) as never;
const modelJson = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }) });
function sseBody(events: unknown[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
}
const okStream = () => ({ ok: true, body: sseBody([{ type: "response.output_text.delta", delta: "Hi" }, { type: "response.completed" }]) });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.control, { broken: false, workItems: [], decisions: [], executions: [], links: [] });
  seq = 0;
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.FEDLIFY_CONTROL_SIGNING_SECRET = "runner-test-signing-secret-0123";
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.audit.mockResolvedValue(undefined);
  h.head.mockResolvedValue("c1");
  h.repo.mockResolvedValue({ ok: true, project: { id: "p1", defaultBranch: "main", study: { orgId: "o1" } }, commit: "c1", files: [{ path: "client.py", content: "x" }] });
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", study: { id: "s1", orgId: "o1" } });
  h.prisma.study.findUnique.mockResolvedValue({ id: "s1" });
  h.prisma.requirementResponse.findMany.mockResolvedValue([]);
  h.prisma.studySite.findMany.mockResolvedValue([]);
  h.prisma.agentTurn.findFirst.mockResolvedValue(null);
  h.prisma.agentTurn.findMany.mockResolvedValue([]);
  h.prisma.agentProposal.create.mockImplementation(async ({ data }: any) => ({ id: "pr1", ...data, createdAt: now, decidedAt: null, acceptedCommit: null, acceptedPaths: null, requestedById: "u1" }));
  h.prisma.agentProposal.update.mockResolvedValue({});
  h.store.getThreadInProject.mockResolvedValue(thread());
  h.store.appendTurn.mockImplementation(async (input: any) => ({ turn: { id: `turn${++seq}`, threadId: "t1", seq, status: "done", payload: null, createdAt: now, content: "", actorUserId: null, model: null, promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null, kind: "MESSAGE", ...input }, duplicate: false }));
  h.store.finalizeTurn.mockResolvedValue(true);
  h.store.linkTurn.mockResolvedValue({});
  h.store.loadHistory.mockResolvedValue([]);
  h.store.setThreadMode.mockResolvedValue({});
  h.store.createPlan.mockImplementation(async (input: any) => ({ id: "plan1", threadId: "t1", version: 1, approvedStepIds: null, decidedById: null, decidedAt: null, createdAt: now, status: "DRAFT", ...input }));
});
afterEach(() => {
  delete process.env.ASSISTANT_CONTROL_MODE;
  delete process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
  vi.restoreAllMocks();
});

const body = (over: Record<string, unknown> = {}) => ({ message: "add FedProx with mu=0.01", mode: "ask", clientTurnId: "c-1", ...over });

describe("runners with the control layer in shadow mode", () => {
  it("ask: records the turn, links both turns, and finishes the work item when the reply is done", async () => {
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body()), params());
    await res.text();
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.workItems[0]).toMatchObject({ idempotencyKey: "turn:t1:c-1", sourceType: "agent_thread", sourceId: "t1", controlState: "WORKER_COMPLETED" });
    expect(h.control.decisions[0]).toMatchObject({ decisionType: "ASSISTANT_TURN" });
    expect(h.control.executions[0]).toMatchObject({ stopReason: "done" });
    expect(h.control.links.flatMap((link) => link.ids)).toEqual(expect.arrayContaining(["turn1", "turn2"]));
    expect(JSON.stringify([h.control.decisions, h.control.workItems])).not.toContain("add FedProx");
  });

  it("ask: the model is still called and the reply completes when the control layer throws", async () => {
    h.control.broken = true;
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body()), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fedlify.done");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.store.finalizeTurn).toHaveBeenCalledWith(expect.any(String), { status: "done", content: "Hi" });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(JSON.stringify((console.warn as any).mock.calls)).not.toContain("FedProx");
  });

  it("ask: a quarantine verdict changes nothing for the person", async () => {
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body({ message: "use sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s for the call" })), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fedlify.done");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.fetch.mock.calls[0][1].body)).toContain("sk-" + "proj-9fA3");
    await vi.waitFor(() => expect(h.control.decisions).toHaveLength(1));
    expect(h.control.decisions[0]!.decision.assistant).toMatchObject({ verdict: "quarantine", wouldBlock: true });
  });

  it("off: no control call at all and the reply is unchanged", async () => {
    process.env.ASSISTANT_CONTROL_MODE = "off";
    h.control.broken = true;
    h.fetch.mockResolvedValue(okStream());
    expect((await (await turnsPost(post(body()), params())).text())).toContain("fedlify.done");
    expect(console.warn).not.toHaveBeenCalled();
    expect(h.control.workItems).toHaveLength(0);
  });

  it("ask: an upstream failure ends the work item as stopped", async () => {
    h.fetch.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await turnsPost(post(body()), params());
    expect(res.status).toBe(502);
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.executions[0]).toMatchObject({ stopReason: "error" });
    expect(h.control.workItems[0]).toMatchObject({ controlState: "STOPPED" });
  });

  it("plan: returns the plan and records one work item with the plan contract", async () => {
    h.fetch.mockResolvedValue(modelJson({ disposition: "PLAN", rationale: "ok", questions: [], plan: { summary: "Do it", steps: [{ id: "s1", title: "Add helper", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false }], assumptions: [], risks: [] } }));
    const res = await turnsPost(post(body({ mode: "plan", clientTurnId: "c-plan" })), params());
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.workItems[0]).toMatchObject({ idempotencyKey: "turn:t1:c-plan", purpose: expect.stringContaining("plan") });
  });

  it("plan: still answers when the control layer throws", async () => {
    h.control.broken = true;
    h.fetch.mockResolvedValue(modelJson({ disposition: "REFUSE", rationale: "no", questions: [], plan: { summary: "", steps: [], assumptions: [], risks: [] } }));
    const res = await turnsPost(post(body({ mode: "plan", clientTurnId: "c-plan2" })), params());
    expect(res.status).toBe(200);
    expect((await res.json()).refused).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("edit (direct proposal): records a change work item and finishes it as done", async () => {
    h.fetch.mockResolvedValue(modelJson({ title: "Add helper", rationale: "because", files: [{ path: "job/app/custom/helper.py", content: "z = 1\n" }] }));
    const res = await proposalsPost(post({ message: "add a helper" }), params());
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.workItems[0]).toMatchObject({ sourceType: "agent_project", sourceId: "p1", allowedTools: ["propose_file_changes"] });
    expect(h.control.executions[0]).toMatchObject({ stopReason: "done" });
  });

  it("edit: no_changes is recorded as no_changes, and a throwing control layer does not change the 422", async () => {
    h.fetch.mockResolvedValue(modelJson({ title: "No change", rationale: "nothing to do", files: [] }));
    let res = await proposalsPost(post({ message: "add a helper" }), params());
    expect(res.status).toBe(422);
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.executions[0]).toMatchObject({ stopReason: "no_changes" });
    h.control.broken = true;
    res = await proposalsPost(post({ message: "add a helper" }), params());
    expect(res.status).toBe(422);
  });
});
