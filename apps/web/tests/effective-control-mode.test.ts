import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    agentTurn: { findMany: vi.fn() },
    agentPlan: { findMany: vi.fn() },
    agentProposal: { findMany: vi.fn() },
    verificationRun: { findMany: vi.fn() },
    approvalBinding: { findMany: vi.fn() },
    user: { findMany: vi.fn() }
  }
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

import { assistantEnforceStudies, effectiveControlMode } from "@/lib/runtime-config";
import { loadThreadDetail } from "@/lib/agent-thread-store";

const set = (mode: string | undefined, studies: string | undefined) => {
  if (mode === undefined) delete process.env.ASSISTANT_CONTROL_MODE;
  else process.env.ASSISTANT_CONTROL_MODE = mode;
  if (studies === undefined) delete process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES;
  else process.env.ASSISTANT_CONTROL_ENFORCE_STUDIES = studies;
};
afterEach(() => set(undefined, undefined));

describe("effectiveControlMode", () => {
  it("is the global mode when no study is listed", () => {
    set("shadow", undefined);
    expect(effectiveControlMode("s1")).toBe("shadow");
    set("shadow", "");
    expect(effectiveControlMode("s1")).toBe("shadow");
    set("enforce", "");
    expect(effectiveControlMode("s1")).toBe("enforce");
  });
  it("enforces a listed study and only that one", () => {
    set("shadow", "s1, s2");
    expect(effectiveControlMode("s1")).toBe("enforce");
    expect(effectiveControlMode("s2")).toBe("enforce");
    expect(effectiveControlMode("s3")).toBe("shadow");
    expect(assistantEnforceStudies()).toEqual({ all: false, ids: ["s1", "s2"] });
  });
  it('"*" means every study', () => {
    set("shadow", "*");
    expect(effectiveControlMode("anything")).toBe("enforce");
  });
  it("off always wins, even for a listed study", () => {
    set("off", "s1");
    expect(effectiveControlMode("s1")).toBe("off");
    set(undefined, "*");
    expect(effectiveControlMode("s1")).toBe("off");
  });
  it("an unknown or missing study id falls back to the global mode", () => {
    set("shadow", "s1");
    expect(effectiveControlMode(undefined)).toBe("shadow");
    expect(effectiveControlMode(null)).toBe("shadow");
  });
});

describe("thread detail says which mode applies", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  const thread = { id: "t1", projectId: "p1", studyId: "s1", createdById: "u1", title: "x", status: "ACTIVE", mode: "plan", turnCount: 0, lastTurnAt: now, createdAt: now, createdBy: { id: "u1", name: "Ana" }, plans: [], _count: { proposals: 0 } };
  const access = { level: "author", readOnly: false, canDecidePlan: true, canArchive: true, canWrite: true, canReadContent: true } as never;
  const plan = { id: "plan1", threadId: "t1", version: 1, summary: "s", steps: [], assumptions: [], baseCommit: "c1", contextHash: "c", requirementsHash: "r", status: "DRAFT", approvedStepIds: null, decidedById: null, decidedAt: null, createdAt: now, artifactRevisionId: "ar1", verificationStatus: "CONCERNS", approvalBindingId: "ab1" };
  beforeEach(() => {
    vi.clearAllMocks();
    h.prisma.agentTurn.findMany.mockResolvedValue([]);
    h.prisma.agentPlan.findMany.mockResolvedValue([plan]);
    h.prisma.agentProposal.findMany.mockResolvedValue([]);
    h.prisma.verificationRun.findMany.mockResolvedValue([
      { artifactRevisionId: "ar1", kind: "DETERMINISTIC", status: "PASSED", findings: [] },
      { artifactRevisionId: "ar1", kind: "SEMANTIC", status: "FAILED", findings: [{ kind: "contradiction", text: "Says X, asked Y." }] }
    ]);
    h.prisma.approvalBinding.findMany.mockResolvedValue([{ id: "ab1", approvedById: "u1", selfApproved: true, status: "APPROVED", approvedAt: now }]);
    h.prisma.user.findMany.mockResolvedValue([{ id: "u1", name: "Ana", email: "ana@example.org" }]);
  });

  it("enforce: controlMode, the second check, findings, the rule check and the approval", async () => {
    set("shadow", "s1");
    const detail = await loadThreadDetail({ thread: thread as never, viewerId: "u1", access });
    expect(detail.controlMode).toBe("enforce");
    expect(detail.plans[0]).toMatchObject({
      verificationStatus: "CONCERNS",
      findings: [{ kind: "contradiction", text: "Says X, asked Y." }],
      ruleCheck: "PASSED",
      approval: { approvedByName: "Ana", selfApproved: true, valid: true }
    });
  });

  it("shadow: the response is exactly what it was, with no new fields", async () => {
    set("shadow", undefined);
    const detail = await loadThreadDetail({ thread: thread as never, viewerId: "u1", access });
    expect(detail).not.toHaveProperty("controlMode");
    expect(detail.plans[0]).not.toHaveProperty("verificationStatus");
    expect(detail.plans[0]).not.toHaveProperty("findings");
    expect(h.prisma.verificationRun.findMany).not.toHaveBeenCalled();
  });
});
