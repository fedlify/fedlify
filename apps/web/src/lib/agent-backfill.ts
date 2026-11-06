/**
 * Backfill of pre-thread assistant proposals into agent threads (design 2.8).
 * For each proposal with files and no threadId: one thread, a USER turn from the prompt and a PROPOSAL turn, and the
 * proposal is linked to both. Idempotent: a proposal is claimed with a compare-and-set on threadId = null, inside the
 * same transaction that creates its rows, so a second run (or two concurrent runs) cannot create duplicates.
 * Legacy rows (files = null) and template agent sessions are never touched. Takes the prisma client as a parameter so
 * the script and the tests share it.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { LIMITS } from "./agent-thread-types";

/** Same rule as threadTitleFrom in agent-thread-store, kept local so the script does not load the app prisma client. */
function titleFrom(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, LIMITS.titleChars) || "New chat";
}

export type BackfillResult = { scanned: number; migrated: number; skipped: number; dryRun: boolean };

export async function backfillAgentThreads(db: PrismaClient, options: { dryRun?: boolean; batchSize?: number; log?: (line: string) => void } = {}): Promise<BackfillResult> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 100;
  const log = options.log ?? (() => undefined);
  const result: BackfillResult = { scanned: 0, migrated: 0, skipped: 0, dryRun };
  let after: string | undefined;

  for (;;) {
    const rows = await db.agentProposal.findMany({
      where: { threadId: null, files: { not: Prisma.DbNull } },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, projectId: true, requestedById: true, prompt: true, title: true, baseCommit: true, contextHash: true, model: true, createdAt: true, project: { select: { studyId: true } } }
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      result.scanned += 1;
      if (dryRun) {
        result.migrated += 1;
        log(`would migrate proposal ${row.id}`);
        continue;
      }
      const done = await db.$transaction(async (tx) => {
        const thread = await tx.agentThread.create({
          data: {
            projectId: row.projectId,
            studyId: row.project.studyId,
            createdById: row.requestedById,
            title: titleFrom(row.prompt),
            mode: "ask",
            turnCount: 2,
            createdAt: row.createdAt,
            lastTurnAt: row.createdAt
          }
        });
        const claim = await tx.agentProposal.updateMany({ where: { id: row.id, threadId: null }, data: { threadId: thread.id } });
        if (claim.count === 0) throw new SkipRow();
        await tx.agentTurn.create({
          data: { threadId: thread.id, seq: 1, role: "USER", kind: "MESSAGE", content: row.prompt, status: "done", actorUserId: row.requestedById, promptVersion: "backfill", createdAt: row.createdAt }
        });
        const proposalTurn = await tx.agentTurn.create({
          data: {
            threadId: thread.id,
            seq: 2,
            role: "ASSISTANT",
            kind: "PROPOSAL",
            content: "",
            payload: { proposalId: row.id },
            status: "done",
            model: row.model,
            promptVersion: "backfill",
            contextHash: row.contextHash,
            baseCommit: row.baseCommit,
            proposalId: row.id,
            createdAt: row.createdAt
          }
        });
        await tx.agentProposal.update({ where: { id: row.id }, data: { turnId: proposalTurn.id } });
        return true;
      }).catch((error: unknown) => {
        if (error instanceof SkipRow) return false;
        throw error;
      });
      if (done) {
        result.migrated += 1;
        log(`migrated proposal ${row.id}`);
      } else {
        result.skipped += 1;
      }
    }
    if (rows.length < batchSize) break;
  }
  return result;
}

class SkipRow extends Error {}
