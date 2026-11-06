import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { tx, db } = vi.hoisted(() => {
  const tx = { agentThread: { update: vi.fn() }, agentTurn: { create: vi.fn() }, agentPlan: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() } };
  const db = {
    agentTurn: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    agentPlan: { updateMany: vi.fn() },
    agentThread: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx))
  };
  return { tx, db };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import {
  appendTurn,
  createPlan,
  derivePhase,
  effectiveTurnStatus,
  finalizeTurn,
  listThreads,
  loadHistory,
  threadProposalDto,
  threadSummaryDto,
  threadTitleFrom,
  transitionPlan,
  turnDto
} from "@/lib/agent-thread-store";
import { agentThreadsEnabled } from "@/lib/runtime-config";
import { AUDIT_ACTIONS, FORBIDDEN_AUDIT_KEYS, LIMITS } from "@/lib/agent-thread-types";

function p2002(target: string) {
  return new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test", meta: { target: [target] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
});

describe("threadTitleFrom", () => {
  it("flattens whitespace and caps at 80 chars", () => {
    expect(threadTitleFrom("  add\n  FedProx ")).toBe("add FedProx");
    expect(threadTitleFrom("x".repeat(200))).toHaveLength(LIMITS.titleChars);
    expect(threadTitleFrom("   ")).toBe("New chat");
  });
});

describe("appendTurn", () => {
  it("names an untitled chat after the first user message, and only then", async () => {
    db.agentTurn.findFirst.mockResolvedValue(null);
    tx.agentTurn.create.mockResolvedValue({ id: "t" });
    tx.agentThread.update.mockReset();
    tx.agentThread.update.mockResolvedValueOnce({ turnCount: 1, title: "New chat" }).mockResolvedValue({});
    await appendTurn({ threadId: "th", role: "USER", content: "Add FedProx to training" });
    expect(tx.agentThread.update).toHaveBeenCalledWith({ where: { id: "th" }, data: { title: "Add FedProx to training" } });
    tx.agentThread.update.mockReset();
    tx.agentThread.update.mockResolvedValueOnce({ turnCount: 2, title: "Add FedProx to training" });
    await appendTurn({ threadId: "th", role: "USER", content: "and tests" });
    expect(tx.agentThread.update).toHaveBeenCalledTimes(1);
  });

  it("uses the incremented thread counter as seq", async () => {
    db.agentTurn.findFirst.mockResolvedValue(null);
    tx.agentThread.update.mockResolvedValue({ turnCount: 7 });
    tx.agentTurn.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "t", ...data }));
    const result = await appendTurn({ threadId: "th", role: "USER", content: "hi", clientTurnId: "c1" });
    expect(result.duplicate).toBe(false);
    expect(tx.agentTurn.create.mock.calls[0][0].data).toMatchObject({ seq: 7, role: "USER", kind: "MESSAGE", clientTurnId: "c1" });
  });

  it("retries on a seq conflict with a new transaction", async () => {
    db.agentTurn.findFirst.mockResolvedValue(null);
    tx.agentThread.update.mockResolvedValueOnce({ turnCount: 3 }).mockResolvedValueOnce({ turnCount: 4 });
    tx.agentTurn.create.mockRejectedValueOnce(p2002("threadId,seq")).mockImplementationOnce(async ({ data }: { data: object }) => ({ id: "t", ...data }));
    const result = await appendTurn({ threadId: "th", role: "ASSISTANT" });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(result.turn).toMatchObject({ seq: 4 });
  });

  it("gives up after repeated seq conflicts and rethrows unrelated errors immediately", async () => {
    db.agentTurn.findFirst.mockResolvedValue(null);
    tx.agentThread.update.mockResolvedValue({ turnCount: 1 });
    tx.agentTurn.create.mockRejectedValue(p2002("threadId,seq"));
    await expect(appendTurn({ threadId: "th", role: "USER" })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(db.$transaction).toHaveBeenCalledTimes(5);
    db.$transaction.mockClear();
    tx.agentTurn.create.mockRejectedValue(new Error("db down"));
    await expect(appendTurn({ threadId: "th", role: "USER" })).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns the stored turn for a repeated clientTurnId without writing", async () => {
    db.agentTurn.findFirst.mockResolvedValue({ id: "old", seq: 2 });
    const result = await appendTurn({ threadId: "th", role: "USER", clientTurnId: "c1" });
    expect(result).toEqual({ turn: { id: "old", seq: 2 }, duplicate: true });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("resolves a race on clientTurnId to the winner's turn", async () => {
    db.agentTurn.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" });
    tx.agentThread.update.mockResolvedValue({ turnCount: 2 });
    tx.agentTurn.create.mockRejectedValue(p2002("threadId,clientTurnId"));
    const result = await appendTurn({ threadId: "th", role: "USER", clientTurnId: "c1" });
    expect(result).toEqual({ turn: { id: "winner" }, duplicate: true });
  });

  it("caps stored content at 20k characters", async () => {
    tx.agentThread.update.mockResolvedValue({ turnCount: 1 });
    tx.agentTurn.create.mockImplementation(async ({ data }: { data: { content: string } }) => data);
    await appendTurn({ threadId: "th", role: "USER", content: "a".repeat(30_000) });
    expect(tx.agentTurn.create.mock.calls[0][0].data.content).toHaveLength(LIMITS.turnContentChars);
  });
});

describe("finalizeTurn", () => {
  it("only finalizes a turn that is still streaming", async () => {
    db.agentTurn.updateMany.mockResolvedValue({ count: 1 });
    expect(await finalizeTurn("t", { status: "stopped", content: "partial" })).toBe(true);
    expect(db.agentTurn.updateMany).toHaveBeenCalledWith({ where: { id: "t", status: "streaming" }, data: { status: "stopped", content: "partial" } });
    db.agentTurn.updateMany.mockResolvedValue({ count: 0 });
    expect(await finalizeTurn("t", { status: "done" })).toBe(false);
  });
});

describe("turn status on read", () => {
  it("reports a turn streaming for over 5 minutes as stopped", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(effectiveTurnStatus("streaming", new Date("2026-11-11T11:50:00Z"), now)).toBe("stopped");
    expect(effectiveTurnStatus("streaming", new Date("2026-11-11T11:58:00Z"), now)).toBe("streaming");
    expect(effectiveTurnStatus("done", new Date("2020-01-01"), now)).toBe("done");
  });

  it("maps rows to DTOs with ISO dates", () => {
    const dto = turnDto({
      id: "t", threadId: "th", seq: 1, role: "USER", kind: "MESSAGE", content: "hi", payload: null, status: "done", actorUserId: "u", model: null,
      promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null,
      createdAt: new Date("2026-11-11T12:00:00Z")
    });
    expect(dto.createdAt).toBe("2026-11-11T12:00:00.000Z");
    expect(dto.payload).toBeNull();
  });
});

describe("loadHistory", () => {
  it("returns finished MESSAGE turns oldest first, skipping empty ones", async () => {
    db.agentTurn.findMany.mockResolvedValue([
      { role: "ASSISTANT", content: "answer" },
      { role: "ASSISTANT", content: "  " },
      { role: "USER", content: "question" }
    ]);
    expect(await loadHistory("th", { beforeSeq: 9 })).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" }
    ]);
    expect(db.agentTurn.findMany.mock.calls[0][0].where).toMatchObject({ threadId: "th", kind: "MESSAGE", seq: { lt: 9 } });
  });
});

describe("plans", () => {
  it("creates the next version and supersedes open plans in one transaction", async () => {
    tx.agentPlan.findFirst.mockResolvedValue({ version: 2 });
    tx.agentPlan.create.mockImplementation(async ({ data }: { data: object }) => data);
    await createPlan({ threadId: "th", summary: "s", steps: [], assumptions: [], baseCommit: "abc", contextHash: "h", requirementsHash: "r" });
    expect(tx.agentPlan.updateMany).toHaveBeenCalledWith({ where: { threadId: "th", status: { in: ["DRAFT", "APPROVED", "STALE"] } }, data: { status: "SUPERSEDED" } });
    expect(tx.agentPlan.create.mock.calls[0][0].data.version).toBe(3);
  });

  it("transitions only from an expected status so a double approve is a no-op", async () => {
    db.agentPlan.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await transitionPlan("p", ["DRAFT"], "APPROVED", { decidedById: "u", approvedStepIds: ["a"] })).toBe(true);
    expect(await transitionPlan("p", ["DRAFT"], "APPROVED", { decidedById: "u" })).toBe(false);
    expect(db.agentPlan.updateMany.mock.calls[0][0].where).toEqual({ id: "p", status: { in: ["DRAFT"] } });
  });
});

describe("listThreads", () => {
  it("scopes to the viewer's own threads and pages with a cursor", async () => {
    const rows = ["a", "b", "c"].map((id) => ({ id }));
    db.agentThread.findMany.mockResolvedValue(rows);
    const page = await listThreads({ projectId: "p", viewerId: "u", scope: "own", take: 2, cursor: "z", q: " fed " });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBe("b");
    const args = db.agentThread.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ projectId: "p", createdById: "u", title: { contains: "fed" } });
    expect(args.cursor).toEqual({ id: "z" });
    db.agentThread.findMany.mockResolvedValue([{ id: "a" }]);
    await listThreads({ projectId: "p", viewerId: "u", scope: "all" });
    expect(db.agentThread.findMany.mock.calls[1][0].where.createdById).toBeUndefined();
  });
});

describe("DTOs", () => {
  const row = { id: "th", projectId: "p", studyId: "s", createdById: "a", title: "secret first message", status: "ACTIVE", mode: "weird", turnCount: 2, lastTurnAt: new Date(0), createdAt: new Date(0) };

  it("marks threads of other users as foreign and can redact the title", () => {
    expect(threadSummaryDto(row, "a").foreign).toBe(false);
    expect(threadSummaryDto(row, "b").foreign).toBe(true);
    expect(threadSummaryDto(row, "b", { redactTitle: true }).title).toBe("");
    expect(threadSummaryDto(row, "a").mode).toBe("ask");
  });

  it("never exposes file contents in thread proposals", () => {
    const dto = threadProposalDto({
      id: "pr", title: null, status: "PROPOSED", baseCommit: "b", acceptedCommit: null, acceptedPaths: null, planId: null, turnId: null,
      files: [{ path: "a.py", action: "update", content: "SECRET", added: 1, removed: 0 }], createdAt: new Date(0), decidedAt: null, rejectedById: null, rejectedAt: null
    });
    expect(JSON.stringify(dto)).not.toContain("SECRET");
    expect(dto.files).toEqual([{ path: "a.py", action: "update", added: 1, removed: 0 }]);
  });
});

describe("derivePhase", () => {
  const turn = (kind: string) => ({ kind: kind as never, role: "ASSISTANT" as const, seq: 1 });
  it("derives phases from proposals, plans and the last turn", () => {
    expect(derivePhase({ turns: [], plans: [], proposals: [] })).toBe("CHATTING");
    expect(derivePhase({ turns: [turn("QUESTIONS")], plans: [], proposals: [] })).toBe("NEEDS_INPUT");
    expect(derivePhase({ turns: [turn("ANSWERS")], plans: [], proposals: [] })).toBe("TRIAGE");
    expect(derivePhase({ turns: [], plans: [{ status: "DRAFT", version: 1 }], proposals: [] })).toBe("PLAN_DRAFT");
    expect(derivePhase({ turns: [], plans: [{ status: "APPROVED", version: 1 }], proposals: [] })).toBe("PLAN_APPROVED");
    expect(derivePhase({ turns: [], plans: [{ status: "STALE", version: 1 }], proposals: [] })).toBe("STALE");
    expect(derivePhase({ turns: [], plans: [{ status: "EXECUTED", version: 1 }], proposals: [{ status: "PROPOSED" }] })).toBe("PROPOSED");
    expect(derivePhase({ turns: [], plans: [], proposals: [{ status: "ACCEPTED" }] })).toBe("ACCEPTED");
    expect(derivePhase({ turns: [], plans: [], proposals: [{ status: "REJECTED" }] })).toBe("REJECTED");
  });
});

describe("flag and contracts", () => {
  it("AGENT_THREADS_ENABLED is off unless explicitly on", () => {
    const old = process.env.AGENT_THREADS_ENABLED;
    try {
      delete process.env.AGENT_THREADS_ENABLED;
      expect(agentThreadsEnabled()).toBe(false);
      process.env.AGENT_THREADS_ENABLED = "false";
      expect(agentThreadsEnabled()).toBe(false);
      process.env.AGENT_THREADS_ENABLED = " TRUE ";
      expect(agentThreadsEnabled()).toBe(true);
      process.env.AGENT_THREADS_ENABLED = "1";
      expect(agentThreadsEnabled()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.AGENT_THREADS_ENABLED;
      else process.env.AGENT_THREADS_ENABLED = old;
    }
  });

  it("audit actions are namespaced and unique; forbidden metadata keys cover message text", () => {
    const values = Object.values(AUDIT_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => v.startsWith("pipeline_project."))).toBe(true);
    expect(FORBIDDEN_AUDIT_KEYS).toContain("message");
  });
});

describe("derivePhase newer state", () => {
  it("a new draft plan or question outranks an older decided proposal", () => {
    expect(derivePhase({ turns: [], plans: [{ status: "DRAFT", version: 2 }], proposals: [{ status: "ACCEPTED" }] })).toBe("PLAN_DRAFT");
    expect(derivePhase({ turns: [{ kind: "QUESTIONS", role: "ASSISTANT", seq: 9 }], plans: [{ status: "EXECUTED", version: 1 }], proposals: [{ status: "REJECTED" }] })).toBe("NEEDS_INPUT");
    expect(derivePhase({ turns: [], plans: [{ status: "EXECUTED", version: 1 }], proposals: [{ status: "ACCEPTED" }] })).toBe("ACCEPTED");
  });
});
