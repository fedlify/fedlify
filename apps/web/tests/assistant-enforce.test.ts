import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const control = {
    broken: false,
    hang: false,
    workItems: [] as Array<Record<string, any>>,
    decisions: [] as Array<Record<string, any>>,
    quarantines: [] as Array<Record<string, any>>,
    executions: [] as Array<Record<string, any>>,
    links: [] as Array<Record<string, any>>,
    artifacts: [] as Array<Record<string, any>>,
    runs: [] as Array<Record<string, any>>,
    planUpdates: [] as Array<Record<string, any>>,
    proposalUpdates: [] as Array<Record<string, any>>
  };
  const guard = async () => {
    if (control.broken) throw new Error("control tables unavailable");
  };
  const tx = {
    workItem: {
      create: async ({ data }: any) => { const row = { id: `wi${control.workItems.length + 1}`, version: 1, ...data }; control.workItems.push(row); return row; },
      updateMany: async ({ where, data }: any) => { const row = control.workItems.find((item) => item.id === where.id)!; Object.assign(row, { ...data, version: row.version + 1 }); return { count: 1 }; }
    },
    decisionRecord: { create: async ({ data }: any) => { control.decisions.push(data); return data; } },
    quarantineRecord: { create: async ({ data }: any) => { control.quarantines.push(data); return data; } },
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
      agentPlan: { findFirst: vi.fn(), updateMany: async ({ where, data }: any) => { control.planUpdates.push({ where, data }); return { count: 1 }; } },
      agentProposal: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: async ({ where, data }: any) => { control.proposalUpdates.push({ where, data }); return { count: 1 }; } },
      artifactRevision: {
        findFirst: async ({ where }: any) => control.artifacts.find((row) => (where.id ? row.id === where.id : row.contentHash === where.contentHash)) ?? null,
        aggregate: async () => ({ _max: { revision: control.artifacts.length } }),
        create: async ({ data }: any) => { const row = { id: `ar${control.artifacts.length + 1}`, ...data }; control.artifacts.push(row); return row; }
      },
      verificationRun: {
        findFirst: async ({ where }: any) => control.runs.find((row) => row.artifactRevisionId === where.artifactRevisionId && row.kind === where.kind) ?? null,
        create: async ({ data }: any) => { const row = { id: `vr${control.runs.length + 1}`, ...data }; control.runs.push(row); return row; }
      },
      skillContract: { findFirst: async ({ where }: any) => { await guard(); if (control.hang) return new Promise(() => undefined); return { id: "sc1", name: where.name, active: true, allowedTools: where.name === "assistant.change.v1" ? ["propose_file_changes"] : [], contractHash: "h", tokenBudget: 1000, timeBudgetSeconds: 60 }; }, create: vi.fn() },
      workItem: { findFirst: async () => { await guard(); return null; }, findUnique: async ({ where }: any) => { await guard(); return control.workItems.find((item) => item.id === where.id) ?? null; } },
      $transaction: async (fn: any) => { await guard(); return fn(tx); }
    },
    store: { getThreadInProject: vi.fn(), getPlanInThread: vi.fn(), transitionPlan: vi.fn(), appendTurn: vi.fn(), finalizeTurn: vi.fn(), linkTurn: vi.fn(), loadHistory: vi.fn(), createPlan: vi.fn(), setThreadMode: vi.fn() }
  };
});

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async () => true, assertStudyAccess: async () => undefined, isForbiddenError: () => false, roleCan: () => true }));
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
const SECRET = "sk-" + "proj-9fA3kLm2Qx7ZpR4tVb8NcY1wEd6HgJ0s";
const thread = (over: Record<string, unknown> = {}) => ({ id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "ask", turnCount: 0, lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 }, ...over });
const params = () => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1", tid: "t1" }) }) as never;
const projectParams = () => ({ params: Promise.resolve({ studyId: "s1", projectId: "p1" }) }) as never;
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://x/t", { method: "POST", body: JSON.stringify(body), headers }) as never;
const modelJson = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }) });
function sseBody(events: unknown[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
}
const okStream = () => ({ ok: true, body: sseBody([{ type: "response.output_text.delta", delta: "Hi" }, { type: "response.completed" }]) });
const body = (over: Record<string, unknown> = {}) => ({ message: "add FedProx with mu=0.01", mode: "ask", clientTurnId: "c-1", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.control, { broken: false, hang: false, workItems: [], decisions: [], quarantines: [], executions: [], links: [], artifacts: [], runs: [], planUpdates: [], proposalUpdates: [] });
  seq = 0;
  process.env.AGENT_THREADS_ENABLED = "true";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ASSISTANT_CONTROL_MODE = "shadow";
  process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "s1";
  process.env.FEDLIFY_CONTROL_SIGNING_SECRET = "enforce-test-signing-secret-0123";
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
  delete process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
  vi.restoreAllMocks();
});

const appended = () => h.store.appendTurn.mock.calls.map((call) => call[0] as Record<string, any>);

describe("enforce: a flagged message", () => {
  it("ask: no model call, the user turn is replaced by a note, a notice with the stop is stored, the work item is STOPPED", async () => {
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body({ message: `use ${SECRET} for the call` })), params());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("fedlify.stop");
    expect(text).toContain("fedlify.done");
    expect(text).not.toContain(SECRET);
    expect(h.fetch).not.toHaveBeenCalled();

    const turns = appended();
    expect(turns[0]).toMatchObject({ role: "USER", content: "[Message withheld: it looked like it contained a password, key or other secret.]" });
    expect(turns[0]!.selection).toBeUndefined();
    expect(turns[1]).toMatchObject({ role: "ASSISTANT", kind: "NOTICE" });
    expect(turns[1]!.payload.stop).toMatchObject({ code: "SENSITIVE_CONTENT", title: expect.any(String), why: expect.any(String), whoDecides: expect.any(String), nextAction: expect.any(String) });
    expect(JSON.stringify(turns)).not.toContain(SECRET);

    expect(h.control.workItems[0]).toMatchObject({ controlState: "STOPPED", stopCondition: "STOP_1_INTAKE", status: "FAILED" });
    expect(h.control.links.at(-1)).toMatchObject({ controlState: "STOPPED", stopCondition: "STOP_1_INTAKE" });
    expect(h.control.links.flatMap((link) => link.ids)).toEqual(expect.arrayContaining(["turn1", "turn2"]));
    expect(h.control.decisions[0]!.decision).toMatchObject({ enforcement: "enforced", controlMode: "enforce" });
  });

  it("the quarantine record is a real one and holds only a hash, reason codes and counts", async () => {
    await (await turnsPost(post(body({ message: `token ${SECRET}` })), params())).text();
    const record = h.control.quarantines[0]!;
    expect(record.sourceType).toBe("ASSISTANT_TURN");
    expect(record.reasonCodes).toContain("SENSITIVE_CONTENT");
    expect(record.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.metadata).not.toHaveProperty("redactedPreview");
    expect(JSON.stringify([record, h.control.decisions, h.control.workItems])).not.toContain(SECRET);
  });

  it("plan: no model call and a JSON answer with the stop", async () => {
    const res = await turnsPost(post(body({ mode: "plan", clientTurnId: "c-plan", message: `my key is ${SECRET}` })), params());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ stopped: true, stop: { code: "SENSITIVE_CONTENT" }, assistantTurn: { kind: "NOTICE" } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.store.createPlan).not.toHaveBeenCalled();
  });

  it("edit (direct proposal): 422 assistant_stopped, no model call, nothing stored without a thread", async () => {
    const res = await proposalsPost(post({ message: `export PASSWORD=hunter2hunter2 and ${SECRET}` }), projectParams());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "assistant_stopped" }, stopped: true, stop: { code: "SENSITIVE_CONTENT" } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.prisma.agentProposal.create).not.toHaveBeenCalled();
  });

  it("edit without a thread: quarantined text hidden in the client's history is stopped too", async () => {
    const res = await proposalsPost(post({ message: "add a helper", history: [{ role: "user", content: `my key is ${SECRET}` }] }), projectParams());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ stop: { code: "SENSITIVE_CONTENT" } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("patient-level rows are named in plain words", async () => {
    const rows = ["patient_id,age,sex,diagnosis", "10001,64,F,E11", "10002,71,M,I10", "10003,58,F,J45", "10004,49,M,E78", "10005,66,F,N18", "10006,52,M,K21"].join("\n");
    const text = await (await turnsPost(post(body({ message: rows })), params())).text();
    expect(h.fetch).not.toHaveBeenCalled();
    const stop = appended()[1]!.payload.stop;
    expect(["RAW_CLINICAL_DATA", "SENSITIVE_CONTENT"]).toContain(stop.code);
    expect(text).toContain("fedlify.stop");
  });
});

describe("enforce: fail closed", () => {
  it("a control failure means no model call and a 'check unavailable' notice; the message is not stored", async () => {
    h.control.broken = true;
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body()), params());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fedlify.stop");
    expect(h.fetch).not.toHaveBeenCalled();
    const turns = appended();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "ASSISTANT", kind: "NOTICE" });
    expect(turns[0]!.payload.stop.code).toBe("CHECK_UNAVAILABLE");
    expect(JSON.stringify(turns)).not.toContain("FedProx");
  });

  it("a check that does not finish in time means no model call", async () => {
    h.control.hang = true;
    const started = Date.now();
    const res = await turnsPost(post(body({ clientTurnId: "c-slow" })), params());
    expect(await res.text()).toContain("CHECK_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(h.fetch).not.toHaveBeenCalled();
  }, 10_000);

  it("plan: control failure means no model call", async () => {
    h.control.broken = true;
    const res = await turnsPost(post(body({ mode: "plan", clientTurnId: "c-plan3" })), params());
    expect(await res.json()).toMatchObject({ stopped: true, stop: { code: "CHECK_UNAVAILABLE" } });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("enforce: a clear message", () => {
  it("ask: the model is called, the turns are stored with the original text and the work item completes", async () => {
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body()), params());
    expect(await res.text()).toContain("fedlify.done");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(appended()[0]).toMatchObject({ role: "USER", content: "add FedProx with mu=0.01" });
    await vi.waitFor(() => expect(h.control.executions).toHaveLength(1));
    expect(h.control.workItems[0]).toMatchObject({ controlState: "WORKER_COMPLETED" });
    expect(h.control.links.flatMap((link) => link.ids)).toEqual(expect.arrayContaining(["turn1", "turn2"]));
  });

  it("plan: the plan gets an artifact revision and a rule-based verification run", async () => {
    h.fetch.mockResolvedValue(modelJson({ disposition: "PLAN", rationale: "ok", questions: [], plan: { summary: "Do it", steps: [{ id: "s1", title: "Add helper", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false }], assumptions: [], risks: [] } }));
    const res = await turnsPost(post(body({ mode: "plan", clientTurnId: "c-plan4" })), params());
    expect(res.status).toBe(201);
    expect(h.control.artifacts).toHaveLength(1);
    expect(h.control.artifacts[0]).toMatchObject({ artifactType: "assistant_plan", sourceCommit: "c1", createdById: "u1" });
    expect(h.control.runs[0]).toMatchObject({ kind: "DETERMINISTIC", status: "PASSED", artifactRevisionId: "ar1" });
    expect(h.control.planUpdates[0]).toMatchObject({ where: { id: "plan1" }, data: { artifactRevisionId: "ar1", workItemId: "wi1" } });
  });

  it("edit: the proposal gets an artifact revision and a verification run reflecting the checks that ran", async () => {
    h.fetch.mockResolvedValue(modelJson({ title: "Add helper", rationale: "because", files: [{ path: "job/app/custom/helper.py", content: "z = 1\n" }] }));
    const res = await proposalsPost(post({ message: "add a helper" }), projectParams());
    expect(res.status).toBe(201);
    expect(h.control.artifacts[0]).toMatchObject({ artifactType: "assistant_proposal" });
    expect(h.control.runs[0]).toMatchObject({ kind: "DETERMINISTIC", status: "PASSED" });
    expect(h.control.runs[0]!.checks.map((check: any) => check.id)).toEqual(["validate_proposal_files", "scan_added_risks", "inside_plan"]);
    expect(h.control.proposalUpdates[0]).toMatchObject({ data: { artifactRevisionId: "ar1" } });
  });
});

describe("enforce: code from a plan approved before enforcement", () => {
  it("fails closed when its approval record cannot be written: no model call, the plan is not consumed", async () => {
    const { requirementsHash } = await import("@/lib/agent-plan");
    const planRow = { id: "plan1", threadId: "t1", version: 1, summary: "s", steps: [{ id: "s1", title: "t", paths: ["job/app/custom/helper.py"], action: "create", rationale: "r", risk: "low", optional: false, enabled: true }], assumptions: [], baseCommit: "c1", contextHash: "x", requirementsHash: requirementsHash([]), status: "APPROVED", approvedStepIds: ["s1"], decidedById: "u2", decidedAt: now, createdAt: now, workItemId: null, artifactRevisionId: null, approvalBindingId: null, verificationStatus: null };
    h.prisma.agentPlan.findFirst.mockResolvedValue(planRow);
    h.store.getPlanInThread.mockResolvedValue(planRow);
    h.store.transitionPlan.mockResolvedValue(true);
    const res = await proposalsPost(post({ message: "write the code", threadId: "t1", planId: "plan1" }), projectParams());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("control_unavailable");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.store.transitionPlan.mock.calls.some((call) => call[2] === "EXECUTED")).toBe(false);
  });
});

describe("enforce: no plain hash of message text", () => {
  it("without the signing secret nothing is recorded and no model call follows", async () => {
    delete process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
    const nextauth = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body({ message: `use ${SECRET} for the call` })), params());
    await res.text();
    if (nextauth !== undefined) process.env.NEXTAUTH_SECRET = nextauth;
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.control.quarantines).toHaveLength(0);
    // The content is still stopped and withheld; only the ledger row (which would need a plain hash) is not written.
    expect(appended().some((turn) => turn.kind === "NOTICE" && turn.payload?.stop?.code === "SENSITIVE_CONTENT")).toBe(true);
    expect(JSON.stringify(appended())).not.toContain(SECRET);
  });
});

describe("shadow stays as it was", () => {
  it("a study that is not listed: the model is called and the text is untouched", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "other-study";
    h.fetch.mockResolvedValue(okStream());
    const res = await turnsPost(post(body({ message: `use ${SECRET} for the call` })), params());
    expect(await res.text()).toContain("fedlify.done");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(appended()[0]).toMatchObject({ role: "USER", content: expect.stringContaining(SECRET) });
    expect(appended().some((turn) => turn.kind === "NOTICE")).toBe(false);
    await vi.waitFor(() => expect(h.control.decisions).toHaveLength(1));
    expect(h.control.decisions[0]!.decision).toMatchObject({ enforcement: "shadow_only" });
    expect(h.control.quarantines[0]!.sourceType).toBe("ASSISTANT_TURN_SHADOW");
    expect(h.control.artifacts).toHaveLength(0);
  });

  it("an empty list changes nothing either", async () => {
    process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = "";
    h.fetch.mockResolvedValue(okStream());
    await (await turnsPost(post(body({ message: `use ${SECRET}` })), params())).text();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
