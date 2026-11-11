import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requirementsHash } from "@/lib/agent-plan";

const h = vi.hoisted(() => {
  const ledger = {
    artifacts: [] as Array<Record<string, any>>,
    runs: [] as Array<Record<string, any>>,
    bindings: [] as Array<Record<string, any>>,
    decisions: [] as Array<Record<string, any>>,
    edges: [] as Array<Record<string, any>>,
    invalidations: [] as Array<Record<string, any>>,
    planUpdates: [] as Array<Record<string, any>>,
    proposalUpdates: [] as Array<Record<string, any>>,
    failBinding: false
  };
  const prisma: Record<string, any> = {
    pipelineProject: { findUnique: vi.fn() },
    requirementResponse: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    agentTurn: { findFirst: vi.fn(), findMany: vi.fn() },
    agentPlan: {
      findUnique: vi.fn(),
      updateMany: async ({ where, data }: any) => { ledger.planUpdates.push({ where, data }); return { count: 1 }; }
    },
    agentProposal: {
      findFirst: vi.fn(),
      updateMany: async ({ where, data }: any) => { ledger.proposalUpdates.push({ where, data }); return { count: 1 }; }
    },
    artifactRevision: {
      findFirst: async ({ where }: any) => ledger.artifacts.find((row) => (where.id ? row.id === where.id : row.contentHash === where.contentHash)) ?? null,
      aggregate: async () => ({ _max: { revision: ledger.artifacts.length } }),
      create: async ({ data }: any) => { const row = { id: `ar${ledger.artifacts.length + 1}`, ...data }; ledger.artifacts.push(row); return row; }
    },
    verificationRun: {
      findFirst: async ({ where }: any) => ledger.runs.find((row) => row.artifactRevisionId === where.artifactRevisionId && row.kind === where.kind) ?? null,
      findMany: async () => ledger.runs,
      create: async ({ data }: any) => { const row = { id: `vr${ledger.runs.length + 1}`, createdAt: new Date(), ...data }; ledger.runs.push(row); return row; }
    },
    approvalBinding: {
      findMany: async () => ledger.bindings,
      create: async ({ data }: any) => {
        if (ledger.failBinding) throw new Error("ledger down");
        const row = { id: `ab${ledger.bindings.length + 1}`, ...data };
        ledger.bindings.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = ledger.bindings.find((item) => item.id === where.id && item.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    decisionRecord: { create: async ({ data }: any) => { const row = { id: `dr${ledger.decisions.length + 1}`, ...data }; ledger.decisions.push(row); return row; } },
    provenanceEdge: { upsert: async ({ create }: any) => { ledger.edges.push(create); return create; } },
    dependencyInvalidation: { create: async ({ data }: any) => { ledger.invalidations.push(data); return data; } },
    $transaction: async (fn: any) => fn(prisma)
  };
  return {
    ledger,
    prisma,
    roles: { current: { read: true, runAgent: true } as Record<string, boolean> },
    audit: vi.fn(),
    repo: vi.fn(),
    head: vi.fn(),
    commit: vi.fn(),
    store: { getThreadInProject: vi.fn(), getPlanInThread: vi.fn(), transitionPlan: vi.fn(), appendTurn: vi.fn() }
  };
});

let currentUser = "u1";
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: currentUser }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async (_u: string, _s: string, perm: string) => h.roles.current[perm] === true,
  assertStudyAccess: async () => undefined,
  isForbiddenError: () => false
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/project-repo", () => ({ loadProjectRepo: (...a: unknown[]) => h.repo(...a) }));
vi.mock("@/lib/gitea", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/gitea")>()), commitGiteaFiles: (...a: unknown[]) => h.commit(...a) }));
vi.mock("@/lib/agent-proposal-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-proposal-store")>()), branchHead: (...a: unknown[]) => h.head(...a) }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { POST as decisionPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/plans/[pid]/decision/route";
import { POST as acceptPostRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals/[id]/accept/route";
import { bindAssistantApproval, invalidateApprovalBinding, invalidateStalePlanApprovals, planContentDigest, proposalContentDigest, revisionHash, secondCheckGate } from "@/lib/assistant-artifacts";

const decisionPost = async (...args: Parameters<typeof decisionPostRaw>) => (await decisionPostRaw(...args)) as Response;
const acceptPost = async (...args: Parameters<typeof acceptPostRaw>) => (await acceptPostRaw(...args)) as Response;

const now = new Date("2026-11-11T10:00:00Z");
const emptyReqHash = requirementsHash([]);
const steps = [{ id: "s1", title: "Add helper", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false, enabled: true }];
const thread = (over: Record<string, unknown> = {}) => ({ id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "plan", turnCount: 0, lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over });
const planRow = (over: Record<string, unknown> = {}) => ({
  id: "plan1", threadId: "t1", version: 1, summary: "Plan summary text", steps, assumptions: [], baseCommit: "c1", contextHash: "ctx", requirementsHash: emptyReqHash,
  status: "DRAFT", approvedStepIds: null, decidedById: null, decidedAt: null, createdAt: now,
  workItemId: "wi1", artifactRevisionId: null, approvalBindingId: null, verificationStatus: null, ...over
});
const planParams = () => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1", pid: "plan1" }) }) as never;
const acceptParams = () => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", id: "pr1" }) }) as never;
const post = (body: unknown) => new Request("http://x/r", { method: "POST", body: JSON.stringify(body) }) as never;
const files = [{ path: "job/app/custom/helper.py", action: "create", content: "z = 1\n", added: 1, removed: 0 }];
const proposalRow = (over: Record<string, unknown> = {}) => ({
  id: "pr1", projectId: "p1", status: "PROPOSED", files, baseCommit: "c1", title: "Add helper", contextHash: "ctx", model: "m", requestedById: "u1",
  planId: null, threadId: "t1", workItemId: "wi2", artifactRevisionId: null, approvalBindingId: null, verificationStatus: null, ...over
});
let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.ledger, { artifacts: [], runs: [], bindings: [], decisions: [], edges: [], invalidations: [], planUpdates: [], proposalUpdates: [], failBinding: false });
  seq = 0;
  currentUser = "u1";
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "s1";
  h.roles.current = { read: true, runAgent: true };
  h.audit.mockResolvedValue(undefined);
  h.head.mockResolvedValue("c1");
  h.repo.mockResolvedValue({ ok: true, project: { id: "p1", defaultBranch: "main", giteaOwner: "o", giteaRepo: "r", study: { orgId: "o1" } }, commit: "c1", files: [{ path: "client.py", content: "x = 1\n" }] });
  h.commit.mockResolvedValue({ commitSha: "c2", changed: 1 });
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", study: { id: "s1", orgId: "o1" } });
  h.prisma.requirementResponse.findMany.mockResolvedValue([]);
  h.prisma.user.findUnique.mockResolvedValue({ name: "Ana", email: "ana@example.org" });
  h.prisma.user.findMany.mockResolvedValue([{ id: "u1", name: "Ana", email: "ana@example.org" }]);
  h.prisma.agentPlan.findUnique.mockResolvedValue(null);
  h.store.getThreadInProject.mockResolvedValue(thread());
  h.store.getPlanInThread.mockResolvedValue(planRow());
  h.store.transitionPlan.mockResolvedValue(true);
  h.store.appendTurn.mockImplementation(async (input: Record<string, unknown>) => ({ turn: { id: `turn${++seq}`, threadId: "t1", seq, status: "done", payload: null, createdAt: now, content: "", actorUserId: null, model: null, promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null, kind: "MESSAGE", role: "USER", ...input }, duplicate: false }));
});
afterEach(() => {
  delete process.env.ASSISTANT_CONTROL_MODE;
  delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
});

describe("artifact hashes", () => {
  const plan = { steps, assumptions: [{ id: "a1", text: "t", needsAck: false }], baseCommit: "c1", requirementsHash: "r1" };
  it("a plan digest is stable and follows steps, assumptions, base commit and requirements", () => {
    expect(planContentDigest(plan)).toBe(planContentDigest({ requirementsHash: "r1", baseCommit: "c1", assumptions: [{ needsAck: false, text: "t", id: "a1" }], steps: [{ ...steps[0]! }] }));
    expect(planContentDigest(plan)).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [{ baseCommit: "c2" }, { requirementsHash: "r2" }, { steps: [] }, { assumptions: [] }]) expect(planContentDigest({ ...plan, ...change })).not.toBe(planContentDigest(plan));
  });
  it("a proposal digest ignores file order and follows paths, content and base commit", () => {
    const a = { path: "a.py", action: "create", content: "1", added: 1, removed: 0 };
    const b = { path: "b.py", action: "update", content: "2", added: 1, removed: 1 };
    const base = proposalContentDigest({ files: [a, b], baseCommit: "c1" });
    expect(proposalContentDigest({ files: [b, a], baseCommit: "c1" })).toBe(base);
    expect(proposalContentDigest({ files: [a, { ...b, content: "3" }], baseCommit: "c1" })).not.toBe(base);
    expect(proposalContentDigest({ files: [a, b], baseCommit: "c2" })).not.toBe(base);
  });
  it("the stored revision hash is tied to the row, so two identical plans do not collide", () => {
    expect(revisionHash("assistant_plan", "p1", "d")).not.toBe(revisionHash("assistant_plan", "p2", "d"));
    expect(revisionHash("assistant_plan", "p1", "d")).toBe(revisionHash("assistant_plan", "p1", "d"));
  });
});

describe("the second-check gate", () => {
  it("lets a passed check through without a reason", () => {
    expect(secondCheckGate("PASSED", undefined)).toEqual({ ok: true, reason: null });
  });
  it.each(["CONCERNS", "UNAVAILABLE", "CHECKING", null])("needs a reason of ten characters when the status is %s", (status) => {
    const none = secondCheckGate(status, undefined);
    expect(none).toMatchObject({ ok: false, code: "second_check_reason_required" });
    expect(secondCheckGate(status, "too short")).toMatchObject({ ok: false });
    expect(secondCheckGate(status, "The reviewer already read it")).toMatchObject({ ok: true, reason: "The reviewer already read it" });
  });
  it("caps the reason at 500 characters", () => {
    const gate = secondCheckGate("CONCERNS", "the reviewer read it and agreed. ".repeat(30));
    expect(gate.ok && gate.reason!.length).toBe(500);
  });
  it("refuses a reason that holds a secret or patient rows, in plain words", () => {
    const secret = "api_key=" + "sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s";
    const gate = secondCheckGate("CONCERNS", `I checked it, ${secret}`);
    expect(gate).toMatchObject({ ok: false, code: "second_check_reason_required" });
    expect(!gate.ok && gate.message).toContain("in words");
    const rows = "patient_id,age,diagnosis\n1001,54,A\n1002,61,B\n1003,47,C";
    expect(secondCheckGate("PASSED", `Going ahead\n${rows}`)).toMatchObject({ ok: false });
  });
});

describe("binding", () => {
  const artifact = { id: "ar1", contentHash: "h".repeat(64), sourceCommit: "c1" };
  it("self-approved when the approver asked for the change; the reason is kept as words, with its hash and length in the decision", async () => {
    const out = await bindAssistantApproval({ kind: "proposal", studyId: "s1", rowId: "pr1", artifact, approverId: "u1", requesterId: "u1", verificationStatus: "CONCERNS", proceedReason: "I read the diff myself", commitSha: "c2", planArtifact: { id: "ar0", contentHash: "p".repeat(64) } });
    expect(out.selfApproved).toBe(true);
    expect(h.ledger.bindings[0]).toMatchObject({ selfApproved: true, status: "APPROVED", artifactRevisionId: "ar1", artifactHash: artifact.contentHash, approvedById: "u1" });
    expect(h.ledger.decisions[0]).toMatchObject({ decisionType: "ASSISTANT_CHANGE_ACCEPTED", rationale: "I read the diff myself" });
    expect(h.ledger.decisions[0]!.decision).toMatchObject({ verificationStatus: "CONCERNS", proceedReason: { chars: 22 }, selfApproved: true });
    expect(JSON.stringify(h.ledger.decisions[0]!.decision)).not.toContain("I read the diff");
    expect(h.ledger.edges.map((edge) => edge.relation).sort()).toEqual(["COMMITTED_AS", "LED_TO"]);
    expect(h.ledger.proposalUpdates[0]).toMatchObject({ where: { id: "pr1" }, data: { approvalBindingId: "ab1", decisionRecordId: "dr1" } });
  });
  it("not self-approved when someone else accepts", async () => {
    const out = await bindAssistantApproval({ kind: "plan", studyId: "s1", rowId: "plan1", artifact, approverId: "u2", requesterId: "u1", verificationStatus: "PASSED", proceedReason: null });
    expect(out.selfApproved).toBe(false);
    expect(h.ledger.bindings[0]).toMatchObject({ selfApproved: false });
    expect(h.ledger.decisions[0]).toMatchObject({ rationale: "Approved after the second check passed." });
    expect(h.ledger.planUpdates[0]).toMatchObject({ data: { approvalBindingId: "ab1" } });
  });
  it("invalidating a binding marks it and opens a dependency invalidation, once", async () => {
    await bindAssistantApproval({ kind: "plan", studyId: "s1", rowId: "plan1", artifact, approverId: "u1", requesterId: "u1", verificationStatus: "PASSED", proceedReason: null });
    expect(await invalidateApprovalBinding({ studyId: "s1", approvalBindingId: "ab1", reason: "The saved code changed.", source: { type: "Commit", id: "c9", hash: "c9" } })).toBe(true);
    expect(h.ledger.bindings[0]).toMatchObject({ status: "INVALIDATED", invalidationReason: "The saved code changed." });
    expect(h.ledger.invalidations[0]).toMatchObject({ targetType: "ApprovalBinding", targetId: "ab1", sourceType: "Commit" });
    expect(await invalidateApprovalBinding({ studyId: "s1", approvalBindingId: "ab1", reason: "again", source: { type: "Commit", id: "c9", hash: "c9" } })).toBe(false);
    expect(h.ledger.invalidations).toHaveLength(1);
    expect(await invalidateApprovalBinding({ studyId: "s1", approvalBindingId: null, reason: "none", source: { type: "Commit", id: "c9", hash: "c9" } })).toBe(false);
  });
});

describe("approve plan in an enforced study", () => {
  it("a clean second check: approves without a reason and binds the approval (self-approved by the author)", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ verificationStatus: "PASSED" }));
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), planParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approval: { selfApproved: true } });
    expect(h.ledger.artifacts[0]).toMatchObject({ artifactType: "assistant_plan" });
    expect(h.ledger.bindings[0]).toMatchObject({ selfApproved: true, approvedById: "u1" });
  });

  it.each(["CONCERNS", "UNAVAILABLE", null])("status %s without a reason: 409 second_check_reason_required and nothing changes", async (status) => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ verificationStatus: status }));
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), planParams());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatchObject({ code: "second_check_reason_required", message: expect.stringContaining("reason") });
    expect(h.store.transitionPlan).not.toHaveBeenCalled();
    expect(h.ledger.bindings).toHaveLength(0);
  });

  it("with a reason it goes ahead and the reason is recorded", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ verificationStatus: "UNAVAILABLE" }));
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"], proceedReason: "The check was down, I reviewed the steps" }), planParams());
    expect(res.status).toBe(200);
    expect(h.ledger.decisions[0]).toMatchObject({ rationale: "The check was down, I reviewed the steps" });
  });

  it("if the approval cannot be recorded the plan goes back to draft", async () => {
    h.ledger.failBinding = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.store.getPlanInThread.mockResolvedValue(planRow({ verificationStatus: "PASSED" }));
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), planParams());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("control_unavailable");
    expect(h.ledger.planUpdates.some((update) => update.data.status === "DRAFT")).toBe(true);
  });

  it("a partial approval records which steps were approved, and their hash, in the decision and the binding", async () => {
    const two = [...steps, { ...steps[0], id: "s2", paths: ["job/app/custom/other.py"] }];
    h.store.getPlanInThread.mockResolvedValue(planRow({ steps: two, verificationStatus: "PASSED" }));
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), planParams());
    expect(res.status).toBe(200);
    expect(h.ledger.decisions[0]!.decision.scope).toMatchObject({ kind: "steps", items: ["s1"], hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const all = await bindAssistantApproval({ kind: "plan", studyId: "s1", rowId: "plan1", artifact: { id: "ar1", contentHash: "h".repeat(64), sourceCommit: "c1" }, approverId: "u1", requesterId: "u1", verificationStatus: "PASSED", proceedReason: null, scope: { kind: "steps", items: ["s1", "s2"], hash: "a".repeat(64) } });
    expect(all.bindingId).toBeTruthy();
    expect(h.ledger.bindings[0]!.evidenceHash).not.toBe(h.ledger.bindings[1]!.evidenceHash);
  });

  it("a reason with a secret in it is refused, in plain words", async () => {
    h.store.getPlanInThread.mockResolvedValue(planRow({ verificationStatus: "CONCERNS" }));
    const secret = "api_key=" + "sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s";
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"], proceedReason: `Fine, ${secret}` }), planParams());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "second_check_reason_required", message: expect.stringContaining("in words") });
    expect(h.ledger.decisions).toHaveLength(0);
  });

  it("outside enforce nothing is asked and nothing is bound", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    const res = await decisionPost(post({ decision: "approve", approvedStepIds: ["s1"] }), planParams());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("approval");
    expect(h.ledger.bindings).toHaveLength(0);
  });
});

describe("accept change in an enforced study", () => {
  beforeEach(() => {
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "PASSED" }));
  });

  it("people may accept their own change: it is recorded as self-approved", async () => {
    const res = await acceptPost(post({}), acceptParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ commitSha: "c2", approval: { selfApproved: true } });
    expect(h.ledger.bindings[0]).toMatchObject({ selfApproved: true, approvedById: "u1" });
    expect(h.ledger.edges.some((edge) => edge.relation === "COMMITTED_AS" && edge.toId === "c2")).toBe(true);
  });

  it("someone else accepting is not self-approved", async () => {
    currentUser = "u2";
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "PASSED", requestedById: "u1" }));
    const res = await acceptPost(post({}), acceptParams());
    expect((await res.json()).approval).toMatchObject({ selfApproved: false });
  });

  it.each(["CONCERNS", "UNAVAILABLE", null])("status %s needs a reason before anything is committed", async (status) => {
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: status }));
    const res = await acceptPost(post({}), acceptParams());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("second_check_reason_required");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.ledger.proposalUpdates.filter((update) => update.data.status === "ACCEPTED")).toHaveLength(0);
  });

  it("with a reason the change is committed and the reason is kept in the decision", async () => {
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "CONCERNS" }));
    const res = await acceptPost(post({ proceedReason: "The extra file is intended" }), acceptParams());
    expect(res.status).toBe(200);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.ledger.decisions[0]).toMatchObject({ rationale: "The extra file is intended" });
  });

  it("a partial accept records the accepted files and their hash; the audit entry keeps the reason and the second-check result", async () => {
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "CONCERNS" }));
    const res = await acceptPost(post({ proceedReason: "The extra file is intended" }), acceptParams());
    expect(res.status).toBe(200);
    expect(h.ledger.decisions[0]!.decision.scope).toMatchObject({ kind: "paths", items: ["job/app/custom/helper.py"] });
    const saved = h.audit.mock.calls.map((call) => call[0]).find((entry) => entry.action === "pipeline_project.agent_save");
    expect(saved.metadata).toMatchObject({ secondCheck: "CONCERNS", selfApproved: true, proceedReason: "The extra file is intended", proceedReasonChars: 26 });
  });

  it("if the approval record cannot be written after the commit, the person is told and the reason is still in the audit entry", async () => {
    h.ledger.failBinding = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "UNAVAILABLE" }));
    const res = await acceptPost(post({ proceedReason: "The check was down, I read it" }), acceptParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.approval).toBeNull();
    expect(json.approvalWarning).toContain("approval record");
    const saved = h.audit.mock.calls.map((call) => call[0]).find((entry) => entry.action === "pipeline_project.agent_save");
    expect(saved.metadata.proceedReason).toBe("The check was down, I read it");
  });

  it("a stale proposal invalidates a binding it had", async () => {
    h.ledger.bindings.push({ id: "ab9", status: "APPROVED" });
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "PASSED", baseCommit: "old", approvalBindingId: "ab9" }));
    h.prisma.agentProposal.updateMany = (async ({ where, data }: any) => { h.ledger.proposalUpdates.push({ where, data }); return { count: 1 }; }) as never;
    const res = await acceptPost(post({}), acceptParams());
    expect(res.status).toBe(409);
    expect(h.ledger.bindings.find((binding) => binding.id === "ab9")).toMatchObject({ status: "INVALIDATED" });
    expect(h.ledger.invalidations[0]).toMatchObject({ targetId: "ab9" });
  });

  it("outside enforce: no reason asked and no binding", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: null }));
    const res = await acceptPost(post({}), acceptParams());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("approval");
    expect(h.ledger.bindings).toHaveLength(0);
  });
});

describe("approved plans lose their approval when the saved code moves", () => {
  it("marks them stale and invalidates the binding; plans on the new head are left alone", async () => {
    h.ledger.bindings.push({ id: "ab5", status: "APPROVED" });
    h.prisma.agentPlan.findMany = vi.fn(async () => [{ id: "plan1", approvalBindingId: "ab5", artifactRevisionId: "ar1" }]);
    expect(await invalidateStalePlanApprovals({ studyId: "s1", projectId: "p1", head: "c9" })).toBe(1);
    expect(h.prisma.agentPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "APPROVED", baseCommit: { not: "c9" }, thread: { projectId: "p1" } }) }));
    expect(h.ledger.planUpdates[0]).toMatchObject({ where: { id: "plan1", status: "APPROVED" }, data: { status: "STALE" } });
    expect(h.ledger.bindings[0]).toMatchObject({ status: "INVALIDATED" });
    delete (h.prisma.agentPlan as Record<string, unknown>).findMany;
  });
  it("accepting a change in an enforced study triggers it", async () => {
    h.prisma.agentProposal.findFirst.mockResolvedValue(proposalRow({ verificationStatus: "PASSED" }));
    h.prisma.agentPlan.findMany = vi.fn(async () => []);
    await acceptPost(post({}), acceptParams());
    expect(h.prisma.agentPlan.findMany).toHaveBeenCalled();
    delete (h.prisma.agentPlan as Record<string, unknown>).findMany;
  });
});
