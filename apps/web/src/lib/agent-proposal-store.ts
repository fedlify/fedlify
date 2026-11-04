/** Persistence helpers for workspace assistant proposals (see agent-proposal.ts for the rules). */

import type { Prisma } from "@prisma/client";
import { getGiteaBranch } from "@/lib/gitea";
import { canTransition, isStaleAgainst, type ProposalFile, type ProposalStatus } from "@/lib/agent-proposal";
import { prisma } from "@/lib/prisma";

export type ProposalRow = Awaited<ReturnType<typeof prisma.agentProposal.findFirst>> & object;

const FILE_ACTIONS = new Set(["create", "update", "delete"]);

/** Stored files JSON back to typed files; anything malformed is dropped rather than trusted. */
export function readStoredFiles(value: Prisma.JsonValue | null | undefined): ProposalFile[] {
  if (!Array.isArray(value)) return [];
  const files: ProposalFile[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || !FILE_ACTIONS.has(String(record.action))) continue;
    if (record.content !== null && typeof record.content !== "string") continue;
    files.push({
      path: record.path,
      content: record.content as string | null,
      action: record.action as ProposalFile["action"],
      added: typeof record.added === "number" ? record.added : 0,
      removed: typeof record.removed === "number" ? record.removed : 0
    });
  }
  return files;
}

export function proposalDto(row: ProposalRow, options: { withContent?: boolean } = {}) {
  const files = readStoredFiles(row.files);
  return {
    id: row.id,
    title: row.title ?? "Proposed change",
    rationale: row.rationale ?? "",
    prompt: row.prompt,
    status: row.status,
    baseCommit: row.baseCommit,
    contextHash: row.contextHash,
    requestedById: row.requestedById,
    acceptedCommit: row.acceptedCommit,
    acceptedPaths: Array.isArray(row.acceptedPaths) ? (row.acceptedPaths as string[]) : null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    files: files.map((file) => ({
      path: file.path,
      action: file.action,
      added: file.added,
      removed: file.removed,
      ...(options.withContent ? { content: file.content } : {})
    }))
  };
}

export async function branchHead(project: { giteaOwner: string | null; giteaRepo: string | null; defaultBranch: string }): Promise<string | null> {
  if (!project.giteaOwner || !project.giteaRepo) return null;
  const branch = await getGiteaBranch({ owner: project.giteaOwner, repo: project.giteaRepo, branchName: project.defaultBranch });
  return branch.commit?.id ?? branch.commit?.sha ?? null;
}

/** Move a PROPOSED proposal to STALE. Only acts when the transition is legal and the row is still PROPOSED. */
export async function markStale(id: string): Promise<boolean> {
  if (!canTransition("PROPOSED", "STALE")) return false;
  const result = await prisma.agentProposal.updateMany({ where: { id, status: "PROPOSED" }, data: { status: "STALE" satisfies ProposalStatus, decidedAt: new Date() } });
  return result.count > 0;
}

/** Mark every PROPOSED proposal of a project whose base commit is not the head as STALE; returns the fresh rows. */
export async function refreshStaleProposals(projectId: string, head: string | null) {
  if (head) {
    await prisma.agentProposal.updateMany({
      where: { projectId, status: "PROPOSED", baseCommit: { not: head } },
      data: { status: "STALE", decidedAt: new Date() }
    });
  }
}

export function isProposalStale(row: { baseCommit: string | null }, head: string | null): boolean {
  return isStaleAgainst(row.baseCommit, head);
}
