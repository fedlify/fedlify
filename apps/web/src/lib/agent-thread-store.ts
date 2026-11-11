/** Persistence for agent threads, turns and plans (append-only transcript; see agent-thread-types.ts). */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readStoredFiles } from "@/lib/agent-proposal-store";
import { loadControlDecorations } from "@/lib/assistant-artifacts";
import { effectiveControlMode } from "@/lib/runtime-config";
import type { ThreadAccess } from "@/lib/agent-thread-access";
import {
  LIMITS,
  THREAD_MODES,
  type EditorSelection,
  type PlanAssumption,
  type PlanDto,
  type PlanStatus,
  type PlanStep,
  type ThreadDetailDto,
  type ThreadMode,
  type ThreadPhase,
  type ThreadProposalDto,
  type ThreadStatus,
  type ThreadSummaryDto,
  type TurnDto,
  type TurnKind,
  type TurnPayload,
  type TurnRole,
  type TurnStatus
} from "@/lib/agent-thread-types";

const MAX_SEQ_RETRIES = 5;

export function threadTitleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > LIMITS.titleChars ? `${flat.slice(0, LIMITS.titleChars - 1)}…` : flat;
}

export function clampContent(content: string): string {
  return content.length > LIMITS.turnContentChars ? content.slice(0, LIMITS.turnContentChars) : content;
}

function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  if (!field) return true;
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes(field);
}

// ---------- DTO mappers ----------

type ThreadRow = {
  id: string;
  projectId: string;
  studyId: string;
  createdById: string;
  title: string;
  status: string;
  mode: string;
  turnCount: number;
  lastTurnAt: Date;
  createdAt: Date;
  createdBy?: { id: string; name: string | null } | null;
  plans?: { status: string }[];
  _count?: { proposals: number };
};

export function threadSummaryDto(row: ThreadRow, viewerId: string, options: { redactTitle?: boolean } = {}): ThreadSummaryDto {
  const mode = (THREAD_MODES as readonly string[]).includes(row.mode) ? (row.mode as ThreadMode) : "ask";
  return {
    id: row.id,
    projectId: row.projectId,
    title: options.redactTitle ? "" : row.title,
    status: row.status as ThreadStatus,
    mode,
    turnCount: row.turnCount,
    lastTurnAt: row.lastTurnAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy?.id ?? row.createdById, name: row.createdBy?.name ?? null },
    foreign: row.createdById !== viewerId,
    planStatus: (row.plans?.[0]?.status as PlanStatus | undefined) ?? null,
    proposalCount: row._count?.proposals ?? 0
  };
}

type TurnRow = {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  kind: string;
  content: string;
  payload: Prisma.JsonValue | null;
  status: string;
  actorUserId: string | null;
  model: string | null;
  promptVersion: string | null;
  contextHash: string | null;
  baseCommit: string | null;
  filePath: string | null;
  selection: Prisma.JsonValue | null;
  clientTurnId: string | null;
  planId: string | null;
  proposalId: string | null;
  createdAt: Date;
};

/** A turn left "streaming" past the stale window is reported as "stopped"; nothing is written. */
export function effectiveTurnStatus(status: string, createdAt: Date, now: Date = new Date()): TurnStatus {
  if (status === "streaming" && now.getTime() - createdAt.getTime() > LIMITS.streamingStaleMs) return "stopped";
  return (["streaming", "done", "error", "stopped"].includes(status) ? status : "done") as TurnStatus;
}

export function turnDto(row: TurnRow, now: Date = new Date()): TurnDto {
  return {
    id: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as TurnRole,
    kind: row.kind as TurnKind,
    content: row.content,
    payload: (row.payload as TurnPayload) ?? null,
    status: effectiveTurnStatus(row.status, row.createdAt, now),
    actorUserId: row.actorUserId,
    model: row.model,
    promptVersion: row.promptVersion,
    contextHash: row.contextHash,
    baseCommit: row.baseCommit,
    filePath: row.filePath,
    selection: (row.selection as EditorSelection | null) ?? null,
    clientTurnId: row.clientTurnId,
    planId: row.planId,
    proposalId: row.proposalId,
    createdAt: row.createdAt.toISOString()
  };
}

type PlanRow = {
  id: string;
  threadId: string;
  version: number;
  summary: string;
  steps: Prisma.JsonValue;
  assumptions: Prisma.JsonValue;
  baseCommit: string;
  contextHash: string;
  requirementsHash: string;
  status: string;
  approvedStepIds: Prisma.JsonValue | null;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

export function planDto(row: PlanRow): PlanDto {
  return {
    id: row.id,
    threadId: row.threadId,
    version: row.version,
    summary: row.summary,
    steps: Array.isArray(row.steps) ? (row.steps as unknown as PlanStep[]) : [],
    assumptions: Array.isArray(row.assumptions) ? (row.assumptions as unknown as PlanAssumption[]) : [],
    baseCommit: row.baseCommit,
    contextHash: row.contextHash,
    requirementsHash: row.requirementsHash,
    status: row.status as PlanStatus,
    approvedStepIds: Array.isArray(row.approvedStepIds) ? (row.approvedStepIds as string[]) : null,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString()
  };
}

type ProposalRow = {
  id: string;
  title: string | null;
  status: string;
  baseCommit: string | null;
  acceptedCommit: string | null;
  acceptedPaths: Prisma.JsonValue | null;
  planId: string | null;
  turnId: string | null;
  files: Prisma.JsonValue | null;
  createdAt: Date;
  decidedAt: Date | null;
  rejectedById: string | null;
  rejectedAt: Date | null;
};

/** Proposal summary inside a thread: paths and line counts only, never file contents. */
export function threadProposalDto(row: ProposalRow): ThreadProposalDto {
  return {
    id: row.id,
    title: row.title ?? "Proposed change",
    status: row.status,
    baseCommit: row.baseCommit,
    acceptedCommit: row.acceptedCommit,
    acceptedPaths: Array.isArray(row.acceptedPaths) ? (row.acceptedPaths as string[]) : null,
    planId: row.planId,
    turnId: row.turnId,
    files: readStoredFiles(row.files).map((file) => ({ path: file.path, action: file.action, added: file.added, removed: file.removed })),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    rejectedById: row.rejectedById,
    rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null
  };
}

/** Coarse thread state from stored rows. The plan protocol (agent-plan.ts) owns the transition rules. */
export function derivePhase(input: { turns: Pick<TurnDto, "kind" | "role" | "seq">[]; plans: Pick<PlanDto, "status" | "version">[]; proposals: Pick<ThreadProposalDto, "status">[] }): ThreadPhase {
  const latestProposal = input.proposals[input.proposals.length - 1];
  const latestPlan = [...input.plans].sort((a, b) => b.version - a.version)[0];
  const last = input.turns[input.turns.length - 1];
  if (latestProposal?.status === "PROPOSED") return "PROPOSED";
  // A plan that is still open, or questions asked after a decided proposal, are newer than that proposal
  // (an executed plan is what produced the proposal).
  if (latestPlan?.status === "DRAFT") return "PLAN_DRAFT";
  if (latestPlan?.status === "APPROVED") return "PLAN_APPROVED";
  if (last?.kind === "QUESTIONS") return "NEEDS_INPUT";
  if (latestProposal) {
    if (latestProposal.status === "ACCEPTED") return "ACCEPTED";
    if (latestProposal.status === "REJECTED") return "REJECTED";
    if (latestProposal.status === "STALE") return "STALE";
  }
  if (latestPlan?.status === "STALE") return "STALE";
  if (last?.kind === "ANSWERS") return "TRIAGE";
  return "CHATTING";
}

// ---------- threads ----------

export async function createThread(input: { projectId: string; studyId: string; createdById: string; firstMessage?: string; mode?: ThreadMode }) {
  return prisma.agentThread.create({
    data: {
      projectId: input.projectId,
      studyId: input.studyId,
      createdById: input.createdById,
      title: threadTitleFrom(input.firstMessage ?? ""),
      mode: input.mode ?? "ask"
    }
  });
}

/** A thread only when it belongs to the project; a thread of another project is treated as missing. */
export async function getThreadInProject(projectId: string, threadId: string) {
  return prisma.agentThread.findFirst({
    where: { id: threadId, projectId },
    include: { createdBy: { select: { id: true, name: true } }, plans: { orderBy: { version: "desc" }, take: 1, select: { status: true } }, _count: { select: { proposals: true } } }
  });
}

export type ListThreadsInput = {
  projectId: string;
  viewerId: string;
  /** Author threads only unless the viewer may see all (manager or auditor). */
  scope: "own" | "all";
  status?: ThreadStatus;
  q?: string;
  cursor?: string;
  take?: number;
};

export async function listThreads(input: ListThreadsInput): Promise<{ rows: Awaited<ReturnType<typeof getThreadInProject>>[]; nextCursor: string | null }> {
  const take = Math.min(Math.max(input.take ?? LIMITS.threadPageSize, 1), 100);
  const where: Prisma.AgentThreadWhereInput = {
    projectId: input.projectId,
    ...(input.scope === "own" ? { createdById: input.viewerId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.q?.trim() ? { title: { contains: input.q.trim(), mode: "insensitive" } } : {})
  };
  const rows = await prisma.agentThread.findMany({
    where,
    orderBy: [{ lastTurnAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: { createdBy: { select: { id: true, name: true } }, plans: { orderBy: { version: "desc" }, take: 1, select: { status: true } }, _count: { select: { proposals: true } } }
  });
  const page = rows.slice(0, take);
  return { rows: page, nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

export async function setThreadStatus(threadId: string, status: ThreadStatus) {
  return prisma.agentThread.update({ where: { id: threadId }, data: { status } });
}

export async function renameThread(threadId: string, title: string) {
  return prisma.agentThread.update({ where: { id: threadId }, data: { title: threadTitleFrom(title) } });
}

export async function setThreadMode(threadId: string, mode: ThreadMode) {
  return prisma.agentThread.update({ where: { id: threadId }, data: { mode } });
}

// ---------- turns ----------

export type AppendTurnInput = {
  threadId: string;
  role: TurnRole;
  kind?: TurnKind;
  content?: string;
  payload?: TurnPayload;
  status?: TurnStatus;
  actorUserId?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  contextHash?: string | null;
  baseCommit?: string | null;
  filePath?: string | null;
  selection?: EditorSelection | null;
  clientTurnId?: string | null;
  planId?: string | null;
  proposalId?: string | null;
};

export type AppendTurnResult = { turn: NonNullable<Awaited<ReturnType<typeof prisma.agentTurn.findFirst>>>; duplicate: boolean };

/**
 * Append a turn with the next seq. The seq comes from the thread's counter incremented in the same transaction;
 * a unique violation on (threadId, seq) retries. A repeated clientTurnId returns the stored turn with duplicate = true.
 */
export async function appendTurn(input: AppendTurnInput): Promise<AppendTurnResult> {
  const clientTurnId = input.clientTurnId ?? null;
  if (clientTurnId) {
    const existing = await prisma.agentTurn.findFirst({ where: { threadId: input.threadId, clientTurnId } });
    if (existing) return { turn: existing, duplicate: true };
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt += 1) {
    try {
      const turn = await prisma.$transaction(async (tx) => {
        const bumped = await tx.agentThread.update({
          where: { id: input.threadId },
          data: { turnCount: { increment: 1 }, lastTurnAt: new Date() },
          select: { turnCount: true, title: true }
        });
        // A chat started without a message is named after the first thing the user writes.
        if (input.role === "USER" && (input.kind ?? "MESSAGE") === "MESSAGE" && bumped.title === "New chat" && (input.content ?? "").trim()) {
          await tx.agentThread.update({ where: { id: input.threadId }, data: { title: threadTitleFrom(input.content ?? "") } });
        }
        return tx.agentTurn.create({
          data: {
            threadId: input.threadId,
            seq: bumped.turnCount,
            role: input.role,
            kind: input.kind ?? "MESSAGE",
            content: clampContent(input.content ?? ""),
            payload: input.payload ? (input.payload as unknown as Prisma.InputJsonValue) : undefined,
            status: input.status ?? "done",
            actorUserId: input.actorUserId ?? null,
            model: input.model ?? null,
            promptVersion: input.promptVersion ?? null,
            contextHash: input.contextHash ?? null,
            baseCommit: input.baseCommit ?? null,
            filePath: input.filePath ?? null,
            selection: input.selection ? (input.selection as unknown as Prisma.InputJsonValue) : undefined,
            clientTurnId,
            planId: input.planId ?? null,
            proposalId: input.proposalId ?? null
          }
        });
      });
      return { turn, duplicate: false };
    } catch (error) {
      lastError = error;
      if (clientTurnId && isUniqueViolation(error, "clientTurnId")) {
        const existing = await prisma.agentTurn.findFirst({ where: { threadId: input.threadId, clientTurnId } });
        if (existing) return { turn: existing, duplicate: true };
      }
      if (!isUniqueViolation(error, "seq")) throw error;
    }
  }
  throw lastError;
}

/** Set the final text and status of a streaming assistant turn. Only an in-progress turn can be finalized. */
export async function finalizeTurn(turnId: string, input: { status: Exclude<TurnStatus, "streaming">; content?: string; model?: string | null; contextHash?: string | null; baseCommit?: string | null; inputTokens?: number | null; outputTokens?: number | null }): Promise<boolean> {
  const result = await prisma.agentTurn.updateMany({
    where: { id: turnId, status: "streaming" },
    data: {
      status: input.status,
      ...(input.content !== undefined ? { content: clampContent(input.content) } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.contextHash !== undefined ? { contextHash: input.contextHash } : {}),
      ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {})
    }
  });
  return result.count > 0;
}

/** Link a turn to the proposal or plan it produced (the only mutation besides finalize). */
export async function linkTurn(turnId: string, link: { planId?: string; proposalId?: string }) {
  return prisma.agentTurn.update({ where: { id: turnId }, data: link });
}

export async function listTurns(threadId: string, options: { afterSeq?: number; take?: number } = {}) {
  const take = Math.min(Math.max(options.take ?? LIMITS.turnPageSize, 1), 500);
  const rows = await prisma.agentTurn.findMany({
    where: { threadId, ...(options.afterSeq ? { seq: { gt: options.afterSeq } } : {}) },
    orderBy: { seq: "asc" },
    take: take + 1
  });
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

/**
 * Prior done chat turns as {role, content} for the model, built server-side from stored turns.
 * Only MESSAGE turns that finished (or stopped with partial text) are included.
 */
export async function loadHistory(threadId: string, options: { beforeSeq?: number; maxTurns?: number } = {}): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await prisma.agentTurn.findMany({
    where: {
      threadId,
      kind: "MESSAGE",
      status: { in: ["done", "stopped"] },
      ...(options.beforeSeq ? { seq: { lt: options.beforeSeq } } : {})
    },
    orderBy: { seq: "desc" },
    take: options.maxTurns ?? 40
  });
  return rows
    .filter((row) => row.content.trim().length > 0)
    .reverse()
    .map((row) => ({ role: row.role === "USER" ? ("user" as const) : ("assistant" as const), content: row.content }));
}

// ---------- plans ----------

export type CreatePlanInput = {
  threadId: string;
  summary: string;
  steps: PlanStep[];
  assumptions: PlanAssumption[];
  baseCommit: string;
  contextHash: string;
  requirementsHash: string;
};

/** Create the next plan version; earlier DRAFT or APPROVED plans of the thread become SUPERSEDED in the same transaction. */
export async function createPlan(input: CreatePlanInput) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const latest = await tx.agentPlan.findFirst({ where: { threadId: input.threadId }, orderBy: { version: "desc" }, select: { version: true } });
        await tx.agentPlan.updateMany({ where: { threadId: input.threadId, status: { in: ["DRAFT", "APPROVED", "STALE"] } }, data: { status: "SUPERSEDED" } });
        return tx.agentPlan.create({
          data: {
            threadId: input.threadId,
            version: (latest?.version ?? 0) + 1,
            summary: input.summary,
            steps: input.steps as unknown as Prisma.InputJsonValue,
            assumptions: input.assumptions as unknown as Prisma.InputJsonValue,
            baseCommit: input.baseCommit,
            contextHash: input.contextHash,
            requirementsHash: input.requirementsHash
          }
        });
      });
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error, "version")) throw error;
    }
  }
  throw lastError;
}

export async function getPlanInThread(threadId: string, planId: string) {
  return prisma.agentPlan.findFirst({ where: { id: planId, threadId } });
}

/**
 * Move a plan between statuses only from an expected status, so a double click or a race is a no-op (returns false).
 * Decision fields are written when a decider is given.
 */
export async function transitionPlan(planId: string, from: PlanStatus[], to: PlanStatus, decision?: { decidedById: string; approvedStepIds?: string[] }): Promise<boolean> {
  const result = await prisma.agentPlan.updateMany({
    where: { id: planId, status: { in: from } },
    data: {
      status: to,
      ...(decision
        ? {
            decidedById: decision.decidedById,
            decidedAt: new Date(),
            ...(decision.approvedStepIds ? { approvedStepIds: decision.approvedStepIds as unknown as Prisma.InputJsonValue } : {})
          }
        : {})
    }
  });
  return result.count > 0;
}

// ---------- hydration ----------

export async function loadThreadDetail(input: { thread: ThreadRow; viewerId: string; access: ThreadAccess; afterSeq?: number }): Promise<ThreadDetailDto> {
  const accessDto = { level: input.access.level, readOnly: input.access.readOnly, canDecidePlan: input.access.canDecidePlan, canArchive: input.access.canArchive };
  const summary = threadSummaryDto(input.thread, input.viewerId);
  const [{ rows: turnRows, hasMore }, planRows, proposalRows] = await Promise.all([
    listTurns(input.thread.id, { afterSeq: input.afterSeq }),
    prisma.agentPlan.findMany({ where: { threadId: input.thread.id }, orderBy: { version: "asc" } }),
    prisma.agentProposal.findMany({ where: { threadId: input.thread.id }, orderBy: { createdAt: "asc" } })
  ]);
  const now = new Date();
  const turns = turnRows.map((row) => turnDto(row, now));
  let plans = planRows.map(planDto);
  let proposals = proposalRows.map(threadProposalDto);
  const phase = derivePhase({ turns, plans, proposals });
  // Enforced studies only: the second check, the rule check and the approval are added; nothing changes otherwise.
  if (effectiveControlMode(input.thread.studyId) === "enforce") {
    const views = await loadControlDecorations(input.thread.studyId, [...planRows, ...proposalRows]).catch(() => new Map());
    plans = plans.map((plan) => ({ ...plan, ...(views.get(plan.id) ?? {}) }));
    proposals = proposals.map((proposal) => ({ ...proposal, ...(views.get(proposal.id) ?? {}) }));
    return { thread: summary, access: accessDto, turns, plans, proposals, phase, hasMore, controlMode: "enforce" };
  }
  return { thread: summary, access: accessDto, turns, plans, proposals, phase, hasMore };
}
