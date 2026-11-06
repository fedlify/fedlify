import { describe, expect, it } from "vitest";
import { backfillAgentThreads } from "@/lib/agent-backfill";

type P = { id: string; projectId: string; requestedById: string; prompt: string; title: string; baseCommit: string; contextHash: string; model: string; createdAt: Date; files: unknown; threadId: string | null; turnId: string | null; project: { studyId: string } };

function fakeDb(initial: P[]) {
  const proposals = initial.map((p) => ({ ...p }));
  const threads: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const tx = {
    agentThread: { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `t${threads.length + 1}`, ...data }; threads.push(row); return row; } },
    agentTurn: { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `tr${turns.length + 1}`, ...data }; turns.push(row); return row; } },
    agentProposal: {
      updateMany: async ({ where, data }: { where: { id: string; threadId: null }; data: Partial<P> }) => {
        const row = proposals.find((p) => p.id === where.id && p.threadId === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<P> }) => Object.assign(proposals.find((p) => p.id === where.id)!, data)
    }
  };
  const db = {
    agentProposal: {
      findMany: async ({ take, cursor, skip }: { take: number; cursor?: { id: string }; skip?: number }) => {
        const open = proposals.filter((p) => p.threadId === null && p.files !== null).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? open.findIndex((p) => p.id === cursor.id) + (skip ?? 0) : 0;
        return open.slice(Math.max(start, 0), Math.max(start, 0) + take);
      }
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = { t: threads.length, r: turns.length, p: JSON.stringify(proposals) };
      try {
        return await fn(tx);
      } catch (error) {
        threads.length = snapshot.t;
        turns.length = snapshot.r;
        const restored = JSON.parse(snapshot.p) as P[];
        proposals.forEach((p, i) => Object.assign(p, restored[i]));
        throw error;
      }
    }
  };
  return { db: db as never, proposals, threads, turns };
}

const row = (id: string, over: Partial<P> = {}): P => ({ id, projectId: "p1", requestedById: "u1", prompt: "Add   FedProx\nplease", title: "T", baseCommit: "b1", contextHash: "h", model: "m", createdAt: new Date("2026-10-01T00:00:00Z"), files: [{ path: "a.py" }], threadId: null, turnId: null, project: { studyId: "s1" }, ...over });

describe("backfillAgentThreads", () => {
  it("dry run writes nothing", async () => {
    const f = fakeDb([row("a"), row("b")]);
    const result = await backfillAgentThreads(f.db, { dryRun: true });
    expect(result).toEqual({ scanned: 2, migrated: 2, skipped: 0, dryRun: true });
    expect(f.threads).toHaveLength(0);
    expect(f.proposals.every((p) => p.threadId === null)).toBe(true);
  });

  it("creates one thread with a user turn and a proposal turn, and a second run is a no-op", async () => {
    const f = fakeDb([row("a"), row("b"), row("legacy", { files: null })]);
    const first = await backfillAgentThreads(f.db, { batchSize: 1 });
    expect(first).toMatchObject({ scanned: 2, migrated: 2, dryRun: false });
    expect(f.threads).toHaveLength(2);
    expect(f.turns).toHaveLength(4);
    expect(f.threads[0]).toMatchObject({ projectId: "p1", studyId: "s1", createdById: "u1", title: "Add FedProx please", turnCount: 2 });
    expect(f.turns[0]).toMatchObject({ seq: 1, role: "USER", content: "Add   FedProx\nplease", promptVersion: "backfill" });
    expect(f.turns[1]).toMatchObject({ seq: 2, role: "ASSISTANT", kind: "PROPOSAL", proposalId: "a", payload: { proposalId: "a" }, promptVersion: "backfill" });
    expect(f.proposals.find((p) => p.id === "a")).toMatchObject({ threadId: "t1", turnId: "tr2" });
    expect(f.proposals.find((p) => p.id === "legacy")?.threadId).toBeNull();

    const second = await backfillAgentThreads(f.db);
    expect(second).toMatchObject({ scanned: 0, migrated: 0 });
    expect(f.threads).toHaveLength(2);
    expect(f.turns).toHaveLength(4);
  });
});
