/**
 * Who may do what with an agent thread (design 2.3). Built on canAccessStudy.
 *
 *  - author (read + runAgent): full access to their own threads.
 *  - manager (manage, i.e. PI / study owner): may read other users' threads, read-only, and archive or rename.
 *  - auditor (audit, no manage): metadata only, never turns, plans or titles (the title is the first message).
 *  - site roles and everyone else: nothing.
 * Plan approval is the author's decision; a manager reading someone else's thread cannot approve or reject.
 */

import { canAccessStudy } from "@/lib/rbac";
import type { ThreadAccessLevel } from "@/lib/agent-thread-types";

export type ThreadAccess = {
  level: ThreadAccessLevel;
  /** May see turns, plans and proposal details. False for the audit role. */
  canReadContent: boolean;
  /** May send turns, answer questions and ask for plans. Author only. */
  canWrite: boolean;
  canDecidePlan: boolean;
  canArchive: boolean;
  readOnly: boolean;
};

type ThreadRef = { studyId: string; createdById: string };

export type ThreadActor = {
  canUse: boolean; // read + runAgent
  canManage: boolean;
  canAudit: boolean;
};

export async function resolveActor(userId: string, studyId: string): Promise<ThreadActor> {
  const [canRead, canRun, canManage, canAudit] = await Promise.all([
    canAccessStudy(userId, studyId, "read"),
    canAccessStudy(userId, studyId, "runAgent"),
    canAccessStudy(userId, studyId, "manage"),
    canAccessStudy(userId, studyId, "audit")
  ]);
  return { canUse: canRead && canRun, canManage: canRead && canManage, canAudit };
}

export function accessFor(actor: ThreadActor, userId: string, thread: ThreadRef): ThreadAccess | null {
  if (thread.createdById === userId && actor.canUse) {
    return { level: "author", canReadContent: true, canWrite: true, canDecidePlan: true, canArchive: true, readOnly: false };
  }
  if (actor.canManage) {
    return { level: "manager", canReadContent: true, canWrite: false, canDecidePlan: false, canArchive: true, readOnly: true };
  }
  if (actor.canAudit) {
    return { level: "auditor", canReadContent: false, canWrite: false, canDecidePlan: false, canArchive: false, readOnly: true };
  }
  return null;
}

/** Access of one user to one existing thread; null means no access (callers answer 404 to avoid leaking existence). */
export async function resolveThreadAccess(userId: string, thread: ThreadRef): Promise<ThreadAccess | null> {
  return accessFor(await resolveActor(userId, thread.studyId), userId, thread);
}

/** Whether the user may create threads and send turns at all (read + runAgent). */
export async function canUseAgentThreads(userId: string, studyId: string): Promise<boolean> {
  return (await resolveActor(userId, studyId)).canUse;
}

/** Throws a ForbiddenError (see rbac.ts) unless the user holds read + runAgent. */
export async function assertCanUseAgentThreads(userId: string, studyId: string): Promise<void> {
  if (!(await canUseAgentThreads(userId, studyId))) {
    const error = new Error("You do not have permission to use the assistant for this study.");
    error.name = "ForbiddenError";
    throw error;
  }
}

export function isForeignAccess(access: ThreadAccess): boolean {
  return access.level !== "author";
}
