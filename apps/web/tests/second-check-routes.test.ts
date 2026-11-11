import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requirementsHash } from "@/lib/agent-plan";

const h = vi.hoisted(() => {
  const db = {
    plan: null as Record<string, any> | null,
    proposal: null as Record<string, any> | null,
    artifacts: [] as Array<Record<string, any>>,
    runs: [] as Array<Record<string, any>>
  };
  const match = (row: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([key, value]) => (value && typeof value === "object" && !(value instanceof Date) ? true : row[key] === value));
  const updateRow = (key: "plan" | "proposal") => async ({ where, data }: any) => {
    const row = db[key];
    if (!row || row.id !== where.id || ("verificationStatus" in where && row.verificationStatus !== where.verificationStatus)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  const prisma: Record<string, any> = {
    pipelineProject: { findUnique: vi.fn() },
    agentTurn: { findMany: vi.fn() },
    agentPlan: { findUnique: async () => db.plan, updateMany: updateRow("plan") },
    agentProposal: { findFirst: async () => db.proposal, findUnique: async () => db.proposal, updateMany: updateRow("proposal") },
    artifactRevision: {
      findFirst: async ({ where }: any) => db.artifacts.find((row) => (where.id ? row.id === where.id : row.contentHash === where.contentHash)) ?? null,
      aggregate: async () => ({ _max: { revision: db.artifacts.length } }),
      create: async ({ data }: any) => { const row = { id: `ar${db.artifacts.length + 1}`, ...data }; db.artifacts.push(row); return row; }
    },
    verificationRun: {
      findFirst: async ({ where }: any) => [...db.runs].reverse().find((row) => match(row, where)) ?? null,
      findMany: async () => [...db.runs].reverse(),
      create: async ({ data }: any) => { const row = { id: `vr${db.runs.length + 1}`, createdAt: new Date(), ...data }; db.runs.push(row); return row; },
      update: async ({ where, data }: any) => { const row = db.runs.find((item) => item.id === where.id)!; Object.assign(row, data); return row; }
    },
    approvalBinding: { findMany: async () => [] },
    user: { findMany: async () => [] },
    skillContract: { findFirst: async ({ where }: any) => ({ id: "sc1", name: where.name, active: true, allowedTools: [], contractHash: "h", tokenBudget: 8000, timeBudgetSeconds: 45 }), create: vi.fn() }
  };
  return { db, prisma, verify: vi.fn(), access: { forbidden: false }, store: { getThreadInProject: vi.fn(), getPlanInThread: vi.fn() } };
});

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async () => true,
  assertStudyAccess: async () => {
    if (h.access.forbidden) throw Object.assign(new Error("You do not have permission."), { name: "ForbiddenError" });
  },
  isForbiddenError: (error: unknown) => error instanceof Error && error.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/orchestrator-client", () => ({ verifyThroughOrchestrator: (...a: unknown[]) => h.verify(...a) }));
vi.mock("@/lib/agent-thread-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent-thread-store")>()), ...h.store }));

import { POST as planVerifyRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]/plans/[pid]/verify/route";
import { POST as proposalVerifyRaw } from "@/app/api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals/[id]/verify/route";
import { signControlPayload } from "@/lib/control-plane";

const planVerify = async (url = "http://x/v") => (await planVerifyRaw(new Request(url, { method: "POST" }) as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1", pid: "plan1" }) } as never)) as Response;
const proposalVerify = async (url = "http://x/v") => (await proposalVerifyRaw(new Request(url, { method: "POST" }) as never, { params: Promise.resolve({ studyId: "s1", projectId: "p1", id: "pr1" }) } as never)) as Response;

const now = new Date("2026-11-11T10:00:00Z");
const SECRET = "sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s";
const thread = { id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "plan", turnCount: 0, lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 } };
const supported = { output: { disposition: "SUPPORTED", findings: [{ severity: "INFO", message: "fine", evidenceIds: [] }], supportedClaimIndexes: [0], unsupportedClaimIndexes: [] }, execution: { model: "m1", promptHash: "ph", outputHash: "oh" } };
const contradicted = (messages: string[], disposition = "CONTRADICTED") => ({ output: { disposition, findings: messages.map((message) => ({ severity: "WARNING", message, evidenceIds: [] })), supportedClaimIndexes: [], unsupportedClaimIndexes: [0] }, execution: { model: "m1" } });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.db, { artifacts: [], runs: [] });
  h.db.plan = { id: "plan1", threadId: "t1", status: "DRAFT", summary: "Add a helper", steps: [{ id: "s1", title: "Add helper", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false, enabled: true }], assumptions: [], baseCommit: "c1", requirementsHash: requirementsHash([]), workItemId: "wi1", artifactRevisionId: null, approvalBindingId: null, verificationStatus: null };
  h.db.proposal = { id: "pr1", projectId: "p1", status: "PROPOSED", files: [{ path: "job/app/custom/helper.py", action: "create", content: "z = 1\n", added: 1, removed: 0 }], baseCommit: "c1", title: "Add helper", rationale: "because", prompt: "add a helper", planId: null, threadId: null, workItemId: null, artifactRevisionId: null, approvalBindingId: null, verificationStatus: null };
  h.access.forbidden = false;
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "s1";
  process.env.FEDLIFY_CONTROL_SIGNING_SECRET = "second-check-signing-secret-0123";
  h.prisma.pipelineProject.findUnique.mockResolvedValue({ id: "p1", studyId: "s1", giteaOwner: "o", giteaRepo: "r", defaultBranch: "main", study: { id: "s1", orgId: "o1" } });
  h.prisma.agentTurn.findMany.mockResolvedValue([{ content: "add a helper function" }]);
  h.store.getThreadInProject.mockResolvedValue(thread);
  h.store.getPlanInThread.mockImplementation(async () => h.db.plan);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.ASSISTANT_CONTROL_MODE;
  delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
  delete process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
  vi.restoreAllMocks();
});

describe("plan second check", () => {
  it("runs once, stores PASSED, and a second call returns the stored result without calling the checker", async () => {
    h.verify.mockResolvedValue(supported);
    const first = await planVerify();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ verification: { status: "PASSED", findings: [], ruleCheck: "PASSED", cached: false } });
    expect(h.db.plan!.verificationStatus).toBe("PASSED");
    expect(h.db.plan!.artifactRevisionId).toBe("ar1");
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.verify.mock.calls[0]![1]).toEqual({ timeoutMs: 45_000 });
    expect(h.db.runs.map((run) => [run.kind, run.status])).toEqual([["DETERMINISTIC", "PASSED"], ["SEMANTIC", "PASSED"]]);

    const second = await planVerify();
    expect((await second.json()).verification).toMatchObject({ status: "PASSED", cached: true });
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("judges the plan against the message that led to it, not a later one or a withheld note", async () => {
    h.verify.mockResolvedValue(supported);
    h.db.plan!.createdAt = now;
    h.prisma.agentTurn.findMany.mockResolvedValue([{ content: "[Message withheld: it looked like it contained a password, key or other secret.]" }, { content: "add a helper function" }]);
    await planVerify();
    expect((h.verify.mock.calls[0]![0] as any).workItem.input.request).toBe("add a helper function");
    const where = h.prisma.agentTurn.findMany.mock.calls[0]![0].where;
    expect(where.createdAt).toEqual({ lte: expect.any(Date) });
  });

  it("sends a signed second-check work item that the orchestrator can verify", async () => {
    h.verify.mockResolvedValue(supported);
    await planVerify();
    const sent = h.verify.mock.calls[0]![0] as { workItem: any; proposal: any };
    expect(sent.workItem).toMatchObject({ role: "SEMANTIC_VERIFIER", studyId: "s1", allowedTools: [], id: "wi1" });
    // The checker is given the request as evidence; with none it can only answer "insufficient evidence".
    expect(sent.workItem.evidence).toEqual([expect.objectContaining({ id: "request", content: "add a helper function" })]);
    expect(sent.workItem.signedPayload.evidenceIds ?? sent.workItem.signedPayload.evidence_ids ?? ["request"]).toEqual(["request"]);
    expect(signControlPayload(sent.workItem.signedPayload)).toBe(sent.workItem.signature);
    expect(sent.workItem.input.request).toBe("add a helper function");
    expect(sent.proposal).toMatchObject({ disposition: "PROPOSE", claims: [{ evidenceIds: ["request"] }] });
  });

  it("treats 'not enough evidence' and plain warnings as notes on a passed check, not as a concern", async () => {
    h.verify.mockResolvedValue({ ...supported, output: { disposition: "INSUFFICIENT_EVIDENCE", findings: [{ severity: "WARNING", message: "Could not judge the test file.", evidenceIds: [] }], supportedClaimIndexes: [], unsupportedClaimIndexes: [0] } });
    const body = (await (await planVerify()).json()).verification;
    expect(body).toMatchObject({ status: "PASSED", findings: [{ kind: "other", text: "Could not judge the test file." }] });
    expect(h.db.plan!.verificationStatus).toBe("PASSED");
  });

  it("a contradiction is CONCERNS with findings; model text is capped, secret-free and plain", async () => {
    h.verify.mockResolvedValue(contradicted([`The plan says X but the request says Y. ${SECRET}`, "b".repeat(2000), ...Array.from({ length: 12 }, (_, index) => `extra ${index}`)]));
    const body = (await (await planVerify()).json()).verification;
    expect(body.status).toBe("CONCERNS");
    expect(body.findings).toHaveLength(8);
    expect(body.findings.every((finding: any) => finding.kind === "contradiction" && finding.text.length <= 400)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(h.db.plan!.verificationStatus).toBe("CONCERNS");
    const again = (await (await planVerify()).json()).verification;
    expect(again).toMatchObject({ status: "CONCERNS", cached: true });
    expect(again.findings).toHaveLength(8);
  });

  it("going beyond the request is its own kind", async () => {
    h.verify.mockResolvedValue(contradicted(["It also rewrites the training loop."], "SCOPE_DRIFT"));
    expect((await (await planVerify()).json()).verification.findings).toEqual([{ kind: "beyond_request", text: "It also rewrites the training loop." }]);
  });

  it("a timeout or error is UNAVAILABLE, stored, and only ?retry=1 asks again", async () => {
    h.verify.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const first = (await (await planVerify()).json()).verification;
    expect(first).toMatchObject({ status: "UNAVAILABLE", findings: [] });
    expect(h.db.plan!.verificationStatus).toBe("UNAVAILABLE");
    expect(h.db.runs.at(-1)).toMatchObject({ kind: "SEMANTIC", status: "BLOCKED" });
    expect(JSON.stringify(h.db.runs)).not.toContain("aborted due to");

    expect((await (await planVerify()).json()).verification).toMatchObject({ status: "UNAVAILABLE", cached: true });
    expect(h.verify).toHaveBeenCalledTimes(1);

    h.verify.mockResolvedValue(supported);
    expect((await (await planVerify("http://x/v?retry=1")).json()).verification).toMatchObject({ status: "PASSED", cached: false });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("a fresh CHECKING mark comes back as CHECKING and no second check starts", async () => {
    h.db.plan!.verificationStatus = "CHECKING";
    h.db.plan!.artifactRevisionId = "ar9";
    h.db.runs.push({ id: "vr9", studyId: "s1", artifactRevisionId: "ar9", kind: "SEMANTIC", status: "RUNNING", createdAt: new Date() });
    expect((await (await planVerify()).json()).verification).toMatchObject({ status: "CHECKING", cached: true });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("needs runAgent", async () => {
    h.access.forbidden = true;
    const res = await planVerify();
    expect(res.status).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("is not available outside enforced studies", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    const res = await planVerify();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("control_not_enforced");
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("a plan that is already decided or replaced is not checked", async () => {
    h.db.plan!.status = "REJECTED";
    expect((await planVerify()).status).toBe(409);
  });
});

describe("proposal second check", () => {
  it("passes, is idempotent, and shows the checker the changed files", async () => {
    h.verify.mockResolvedValue(supported);
    expect((await (await proposalVerify()).json()).verification).toMatchObject({ status: "PASSED", ruleCheck: "PASSED", cached: false });
    expect(h.db.proposal!.verificationStatus).toBe("PASSED");
    const sent = h.verify.mock.calls[0]![0] as { proposal: any; workItem: any };
    expect(sent.proposal.artifact.files[0]).toMatchObject({ path: "job/app/custom/helper.py", content: "z = 1\n" });
    expect(sent.workItem.input.request).toBe("add a helper");
    expect((await (await proposalVerify()).json()).verification.cached).toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("concerns and unavailable are stored on the proposal", async () => {
    h.verify.mockResolvedValue(contradicted(["Adds a file nobody asked for."], "SCOPE_DRIFT"));
    expect((await (await proposalVerify()).json()).verification).toMatchObject({ status: "CONCERNS" });
    h.verify.mockRejectedValue(new Error("down"));
    expect((await (await proposalVerify("http://x/v?retry=1")).json()).verification).toMatchObject({ status: "UNAVAILABLE" });
    expect(h.db.proposal!.verificationStatus).toBe("UNAVAILABLE");
  });

  it("needs runAgent and an open proposal", async () => {
    h.access.forbidden = true;
    expect((await proposalVerify()).status).toBe(403);
    h.access.forbidden = false;
    h.db.proposal!.status = "REJECTED";
    expect((await proposalVerify()).status).toBe(409);
  });
});
