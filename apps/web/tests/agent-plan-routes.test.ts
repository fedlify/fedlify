import { beforeEach, describe, expect, it, vi } from "vitest";
import { requirementsHash } from "@/lib/agent-plan";

const h = vi.hoisted(() => ({
  roles: { current: { read: true, runAgent: true, manage: false, audit: false } as Record<string, boolean> },
  audit: vi.fn(),
  fetch: vi.fn(),
  repo: vi.fn(),
  head: vi.fn(),
  prisma: {
    study: { findUnique: vi.fn() },
    requirementResponse: { findMany: vi.fn() },
    studySite: { findMany: vi.fn() },
    pipelineProject: { findUnique: vi.fn() },
    agentTurn: { findFirst: vi.fn(), findMany: vi.fn() },
    agentPlan: { findFirst: vi.fn() },
    agentProposal: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() }
  },
  store: { getThreadInProject: vi.fn(), getPlanInThread: vi.fn(), transitionPlan: vi.fn(), appendTurn: vi.fn(), loadHistory: vi.fn() }
}));

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async (_u: string, _s: string, perm: string) => h.roles.current[perm] === true,
  assertStudyAccess: async () => undefined,
  isForbiddenError: () => false
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => true, acquireSlot: () => () => undefined }));
vi.mock("@/lib/diagnostics-access", () => ({ loadDiagnosticsForMessage: async () => null }));
vi.mock("@/lib/project-repo", () => ({ loadProjectRepo: (...a: unknown[]) => h.repo(...a) }));
vi.mock("@/lib/agent-proposal-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-proposal-store")>()), branchHead: (...a: unknown[]) => h.head(...a) }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { POST as decisionPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/plans/[pid]/decision/route";
import { POST as codePostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/plans/[pid]/code/route";
import { POST as proposalsPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals/route";
import { POST as rejectPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals/[id]/reject/route";
import { FORBIDDEN_AUDIT_KEYS } from "@/lib/agent-thread-types";

const decisionPost = async (...args: Parameters<typeof decisionPostRaw>) => (await decisionPostRaw(...args)) as Response;
const codePost = async (...args: Parameters<typeof codePostRaw>) => (await codePostRaw(...args)) as Response;
const proposalsPost = async (...args: Parameters<typeof proposalsPostRaw>) => (await proposalsPostRaw(...args)) as Response;
const rejectPost = async (...args: Parameters<typeof rejectPostRaw>) => (await rejectPostRaw(...args)) as Response;

const now = new Date("2026-11-11T10:00:00Z");
const thread = (over: Record<string, unknown> = {}) => ({
  id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "plan", turnCount: 0, lastTurnAt: now, createdAt: now,
  createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over
});
const emptyReqHash = requirementsHash([]);
const steps = [
  { id: "s1", title: "Add helper", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false, enabled: true },
  { id: "s2", title: "Optional", paths: ["job/app/custom/other.py"], action: "create", rationale: "r", risk: "low", optional: true, enabled: false }
];
const planRow = (over: Record<string, unknown> = {}) => ({
  id: "plan1", threadId: "t1", version: 1, summary: "Plan summary text", steps, assumptions: [], baseCommit: "c1", contextHash: "ctx", requirementsHash: emptyReqHash,
  status: "DRAFT", approvedStepIds: null, decidedById: null, decidedAt: null, createdAt: now, ...over
});
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1", pid: "plan1", id: "pr1", ...extra }) }) as never;
const post = (body: unknown) => new Request("http://x/r", { method: "POST", body: JSON.stringify(body) }) as never;
let seq = 0;

function proposalBody(files: Array<{ path: string; content: string | null }>, rationale = "because") {
  return { ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ title: "Add helper", rationale, files }) }] }] }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  vi.stubGlobal("fetch", h.fetch);
  h.roles.current = { read: true, runAgent: true, manage: false, audit: false };
  h.audit.mockResolvedValue(undefined);
  h.head.mockResolvedValue("c1");
  h.repo.mockResolvedValue({ ok: true, project: { id: "p1", defaultBranch: "main", study: { orgId: "o1" } }, commit: "c1", files: [{ path: "client.py", content: "x = 1\n" }] });
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", study: { id: "s1", orgId: "o1" } });
  h.prisma.study.findUnique.mockResolvedValue({ id: "s1" });
  h.prisma.requirementResponse.findMany.mockResolvedValue([]);
  h.prisma.studySite.findMany.mockResolvedValue([]);
  h.prisma.agentTurn.findMany.mockResolvedValue([]);
  h.prisma.agentPlan.findFirst.mockImplementation(async () => planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
  h.prisma.agentProposal.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "pr1", ...data, createdAt: now, decidedAt: null, acceptedCommit: null, acceptedPaths: null, requestedById: "u1" }));
  h.prisma.agentProposal.update.mockResolvedValue({});
  h.prisma.agentProposal.delete.mockResolvedValue({});
  h.store.getThreadInProject.mockResolvedValue(thread());
  h.store.getPlanInThread.mockResolvedValue(planRow());
  h.store.transitionPlan.mockResolvedValue(true);
  h.store.loadHistory.mockResolvedValue([]);
  h.store.appendTurn.mockImplementation(async (input: Record<string, unknown>) => ({
    turn: { id: `turn${++seq}`, seq, status: "done", payload: null, createdAt: now, content: "", actorUserId: null, model: null, promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null, ...input },
    duplicate: false
  }));
});

const auditKeys = () => h.audit.mock.calls.flatMap((call) => Object.keys((call[0] as { metadata: object }).metadata));

describe("plan decision route", () => {
  it("approves a current plan, saves the chosen steps, and audits ids and a hash only", async () => {
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), params());
    expect(res.status).toBe(200);
    expect(h.store.transitionPlan).toHaveBeenCalledWith("plan1", ["DRAFT"], "APPROVED", { decidedById: "u1", approvedStepIds: ["s1"] });
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ kind: "PLAN_DECISION", payload: { planId: "plan1", decision: "approve" } });
    const entry = h.audit.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "pipeline_project.agent_plan_approve", metadata: { planId: "plan1", approvedStepCount: 1 } });
    expect(entry.metadata.stepsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("Plan summary text");
    expect(auditKeys().filter((key) => (FORBIDDEN_AUDIT_KEYS as readonly string[]).includes(key))).toEqual([]);
  });

  it("refuses with plan_stale and marks the plan STALE when the head moved", async () => {
    h.head.mockResolvedValue("c2");
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("plan_stale");
    expect(h.store.transitionPlan).toHaveBeenCalledWith("plan1", ["DRAFT", "APPROVED"], "STALE");
    expect(h.audit.mock.calls[0][0]).toMatchObject({ action: "pipeline_project.agent_plan_stale", metadata: { reason: "head_moved" } });
  });

  it("refuses with plan_stale when the study requirements changed", async () => {
    h.prisma.requirementResponse.findMany.mockResolvedValue([{ requirementId: "R01", answer: "new answer" }]);
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect((await res.json()).error.code).toBe("plan_stale");
    expect(h.audit.mock.calls[0][0].metadata.reason).toBe("requirements_changed");
  });

  it("refuses until flagged assumptions are acknowledged", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ assumptions: [{ id: "a1", text: "uses mu from requirements", needsAck: true }] }));
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "assumptions_not_acknowledged", details: ["a1"] });
    expect(h.store.transitionPlan).not.toHaveBeenCalled();
    expect((await decisionPost(post({ decision: "approve", ackAssumptions: ["a1"] }), params())).status).toBe(200);
  });

  it("treats a second approve as a no-op", async () => {
    h.store.appendTurn.mockImplementationOnce(async () => ({ turn: { id: "old", seq: 1, status: "done", payload: null, createdAt: now, content: "" }, duplicate: true }));
    h.store.getPlanInThread.mockResolvedValue(planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).noop).toBe(true);
    expect(h.store.transitionPlan).not.toHaveBeenCalled();
    // A decision turn already stored for this plan: nothing new to record or audit.
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("writes the missing decision turn and audit event when an approve is retried after a failed write", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect(res.status).toBe(200);
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ kind: "PLAN_DECISION", clientTurnId: "plan-decision:plan1:approve" });
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("treats losing the approve race to another approve as a no-op", async () => {
    h.store.transitionPlan.mockResolvedValue(false);
    h.store.getPlanInThread.mockResolvedValueOnce(planRow()).mockResolvedValueOnce(planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
    const res = await decisionPost(post({ decision: "approve" }), params());
    expect((await res.json()).noop).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("rejects unknown or empty step selections", async () => {
    expect((await decisionPost(post({ decision: "approve", approvedStepIds: ["zz"] }), params())).status).toBe(400);
    expect((await decisionPost(post({ decision: "approve", approvedStepIds: [] }), params())).status).toBe(400);
  });

  it("lets only the author decide: a manager reading the thread is refused", async () => {
    h.store.getThreadInProject.mockResolvedValue(thread({ createdById: "u2" }));
    h.roles.current = { read: true, runAgent: true, manage: true, audit: false };
    expect((await decisionPost(post({ decision: "approve" }), params())).status).toBe(403);
    expect(h.store.transitionPlan).not.toHaveBeenCalled();
  });

  it("records a rejection", async () => {
    const res = await decisionPost(post({ decision: "reject" }), params());
    expect(res.status).toBe(200);
    expect(h.store.transitionPlan).toHaveBeenCalledWith("plan1", ["DRAFT", "APPROVED", "STALE"], "REJECTED", { decidedById: "u1" });
    expect(h.audit.mock.calls[0][0].action).toBe("pipeline_project.agent_plan_reject");
  });

  it("is 404 for a plan outside the thread", async () => {
    h.store.getPlanInThread.mockResolvedValue(null);
    expect((await decisionPost(post({ decision: "approve" }), params())).status).toBe(404);
  });
});

describe("plan code route", () => {
  const approved = () => h.prisma.agentPlan.findFirst.mockResolvedValue(planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
  beforeEach(() => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ status: "APPROVED", approvedStepIds: ["s1"] }));
    approved();
  });

  it("answers 409 plan_not_approved for a draft plan and never calls the model", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow());
    const res = await codePost(post({}), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("plan_not_approved");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("answers 409 plan_stale when the head moved and marks the plan STALE", async () => {
    h.repo.mockResolvedValue({ ok: true, project: { id: "p1", defaultBranch: "main", study: { orgId: "o1" } }, commit: "c2", files: [] });
    const res = await codePost(post({}), params());
    expect((await res.json()).error.code).toBe("plan_stale");
    expect(h.store.transitionPlan).toHaveBeenCalledWith("plan1", ["DRAFT", "APPROVED"], "STALE");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("creates a linked proposal and PROPOSAL turn, claims the plan, and flags paths outside the plan", async () => {
    h.fetch.mockResolvedValue(proposalBody([{ path: "job/app/custom/helper.py", content: "def f():\n    return 1\n" }, { path: "extra.py", content: "y = 2\n" }]));
    const res = await codePost(post({}), params());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outsidePlanPaths).toEqual(["extra.py"]);
    expect(h.prisma.agentProposal.create.mock.calls[0][0].data).toMatchObject({ threadId: "t1", planId: "plan1", status: "PROPOSED", baseCommit: "c1" });
    expect(h.prisma.agentProposal.create.mock.calls[0][0].data.rationale).toContain("Outside the approved plan: extra.py");
    expect(h.store.transitionPlan).toHaveBeenCalledWith("plan1", ["APPROVED"], "EXECUTED");
    expect(h.store.transitionPlan).not.toHaveBeenCalledWith("plan1", ["EXECUTED"], "APPROVED");
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ kind: "PROPOSAL", role: "ASSISTANT", proposalId: "pr1", planId: "plan1" });
    expect(h.prisma.agentProposal.update).toHaveBeenCalledWith({ where: { id: "pr1" }, data: { turnId: "turn1" } });
    // The approved plan and the allowed paths reach the model.
    const sent = JSON.stringify(JSON.parse(h.fetch.mock.calls[0][1].body).input);
    expect(sent).toContain("approved_plan");
    expect(sent).toContain("job/app/custom/helper.py");
    expect(sent).not.toContain("job/app/custom/other.py");
    expect(h.audit.mock.calls[0][0].metadata).toMatchObject({ proposalId: "pr1", planId: "plan1", threadId: "t1", outsidePlanPaths: ["extra.py"] });
  });

  it("stores no_changes as a turn, answers 422, and gives the plan back", async () => {
    h.fetch.mockResolvedValue(proposalBody([], "nothing needed"));
    const res = await codePost(post({}), params());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("no_changes");
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ role: "ASSISTANT", kind: "MESSAGE", content: "nothing needed" });
    expect(h.prisma.agentProposal.create).not.toHaveBeenCalled();
    expect(h.store.transitionPlan).toHaveBeenLastCalledWith("plan1", ["EXECUTED"], "APPROVED");
  });

  it("stores a NOTICE for a proposal that breaks a rule", async () => {
    h.fetch.mockResolvedValue(proposalBody([{ path: ".github/workflows/x.yml", content: "a" }]));
    const res = await codePost(post({}), params());
    expect(res.status).toBe(422);
    expect(h.store.appendTurn.mock.calls[0][0]).toMatchObject({ kind: "NOTICE" });
    expect(h.store.transitionPlan).toHaveBeenLastCalledWith("plan1", ["EXECUTED"], "APPROVED");
  });

  it("leaves no orphan proposal when the turn insert fails", async () => {
    h.fetch.mockResolvedValue(proposalBody([{ path: "job/app/custom/helper.py", content: "z = 1\n" }]));
    h.store.appendTurn.mockRejectedValue(new Error("db down"));
    const res = await codePost(post({}), params());
    expect(res.status).toBe(500);
    expect(h.prisma.agentProposal.delete).toHaveBeenCalledWith({ where: { id: "pr1" } });
    expect(h.store.transitionPlan).toHaveBeenLastCalledWith("plan1", ["EXECUTED"], "APPROVED");
  });

  it("refuses a read-only viewer", async () => {
    h.store.getThreadInProject.mockResolvedValue(thread({ createdById: "u2" }));
    h.roles.current = { read: true, runAgent: true, manage: true, audit: false };
    expect((await codePost(post({}), params())).status).toBe(403);
  });
});

describe("proposals route", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ message: "add a helper", ...extra });

  it("keeps the stateless flow when no thread is given, even with the flag off", async () => {
    process.env.AGENT_THREADS_ENABLED = "false";
    h.fetch.mockResolvedValue(proposalBody([{ path: "job/app/custom/helper.py", content: "z = 1\n" }]));
    const res = await proposalsPost(post(body()), params());
    expect(res.status).toBe(201);
    expect(h.prisma.agentProposal.create.mock.calls[0][0].data).not.toHaveProperty("threadId");
    expect(h.store.appendTurn).not.toHaveBeenCalled();
  });

  it("answers 404 threads_disabled for a threadId when the flag is off", async () => {
    process.env.AGENT_THREADS_ENABLED = "false";
    const res = await proposalsPost(post(body({ threadId: "t1" })), params());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("threads_disabled");
  });

  it("answers 409 plan_not_approved for a draft plan and for a plan-mode thread without a plan", async () => {
    h.prisma.agentPlan.findFirst.mockResolvedValue(planRow());
    h.store.getPlanInThread.mockResolvedValue(planRow());
    let res = await proposalsPost(post(body({ threadId: "t1", planId: "plan1" })), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("plan_not_approved");
    res = await proposalsPost(post(body({ threadId: "t1" })), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("plan_not_approved");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("allows a direct Edit in an ask-mode thread and stores both turns", async () => {
    h.store.getThreadInProject.mockResolvedValue(thread({ mode: "ask" }));
    h.fetch.mockResolvedValue(proposalBody([{ path: "job/app/custom/helper.py", content: "z = 1\n" }]));
    const res = await proposalsPost(post(body({ threadId: "t1", clientTurnId: "c1" })), params());
    expect(res.status).toBe(201);
    expect(h.store.appendTurn.mock.calls.map((c) => [c[0].role, c[0].kind ?? "MESSAGE"])).toEqual([["USER", "MESSAGE"], ["ASSISTANT", "PROPOSAL"]]);
    expect(h.prisma.agentProposal.create.mock.calls[0][0].data).toMatchObject({ threadId: "t1" });
  });

  it("does not call the model when the request turn cannot be stored", async () => {
    h.store.getThreadInProject.mockResolvedValue(thread({ mode: "ask" }));
    h.store.appendTurn.mockRejectedValue(new Error("db down"));
    expect((await proposalsPost(post(body({ threadId: "t1" })), params())).status).toBe(500);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("reject route", () => {
  it("records who rejected and when", async () => {
    h.prisma.agentProposal.findFirst.mockResolvedValue({ id: "pr1", status: "PROPOSED", files: [], contextHash: "c", baseCommit: "c1" });
    h.prisma.agentProposal.updateMany.mockResolvedValue({ count: 1 });
    const res = await rejectPost(post({}), params());
    expect(res.status).toBe(200);
    expect(h.prisma.agentProposal.updateMany.mock.calls[0][0].data).toMatchObject({ status: "REJECTED", rejectedById: "u1", rejectedAt: expect.any(Date) });
  });
});
