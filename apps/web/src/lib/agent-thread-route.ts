/** Shared guards for the agent thread routes: feature flag, project, actor and thread access. */

import { prisma } from "@/lib/prisma";
import { problem } from "@/lib/json";
import { agentThreadsEnabled } from "@/lib/runtime-config";
import { accessFor, resolveActor, type ThreadAccess, type ThreadActor } from "@/lib/agent-thread-access";
import { getThreadInProject } from "@/lib/agent-thread-store";
import { THREAD_ERROR_CODES } from "@/lib/agent-thread-types";
import { audit } from "@/lib/audit";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";

export function threadsDisabledResponse(): NextResponse {
  return problem(404, "Assistant history is not enabled.", THREAD_ERROR_CODES.disabled);
}

type ProjectRow = NonNullable<Awaited<ReturnType<typeof findProject>>>;
function findProject(projectId: string) {
  return prisma.pipelineProject.findUnique({ where: { id: projectId }, include: { study: { select: { id: true, orgId: true } } } });
}

type ThreadRow = NonNullable<Awaited<ReturnType<typeof getThreadInProject>>>;

export type ThreadRouteContext =
  | { ok: false; response: NextResponse }
  | { ok: true; project: ProjectRow; actor: ThreadActor; thread: ThreadRow | null; access: ThreadAccess | null };

/**
 * Flag, project and actor checks, plus the thread when `threadId` is given.
 * No access to a thread answers 404 so its existence is not leaked.
 */
export async function openThreadRoute(input: { userId: string; studyId: string; projectId: string; threadId?: string }): Promise<ThreadRouteContext> {
  if (!agentThreadsEnabled()) return { ok: false, response: threadsDisabledResponse() };
  const project = await findProject(input.projectId);
  if (!project || project.studyId !== input.studyId) return { ok: false, response: problem(404, "Pipeline project not found for this study.", "not_found") };
  const actor = await resolveActor(input.userId, input.studyId);
  if (!actor.canUse && !actor.canManage && !actor.canAudit) return { ok: false, response: problem(403, "You do not have permission to use the assistant for this study.", "forbidden") };
  if (!input.threadId) return { ok: true, project, actor, thread: null, access: null };
  const thread = await getThreadInProject(input.projectId, input.threadId);
  if (!thread || thread.studyId !== input.studyId) return { ok: false, response: problem(404, "Thread not found.", "not_found") };
  const access = accessFor(actor, input.userId, thread);
  if (!access) return { ok: false, response: problem(404, "Thread not found.", "not_found") };
  return { ok: true, project, actor, thread, access };
}

/** Writers are authors of a live thread. Everyone else is read-only; archived threads take no new turns. */
export function writableThreadOrResponse(ctx: Extract<ThreadRouteContext, { ok: true }>): NextResponse | null {
  if (!ctx.thread || !ctx.access) return problem(404, "Thread not found.", "not_found");
  if (!ctx.access.canWrite) return problem(403, "This thread is read-only for you.", THREAD_ERROR_CODES.readOnly);
  if (ctx.thread.status === "ARCHIVED") return problem(409, "This thread is archived.", THREAD_ERROR_CODES.threadArchived);
  return null;
}

/** Audit with ids and counts only. Message text, titles, answers and plan text never go in metadata. */
export async function auditThread(input: {
  request: NextRequest;
  userId: string;
  orgId: string;
  studyId: string;
  projectId: string;
  action: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await audit({
    actorUserId: input.userId,
    orgId: input.orgId,
    studyId: input.studyId,
    action: input.action,
    targetType: "PipelineProject",
    targetId: input.projectId,
    metadata: input.metadata,
    request: input.request
  });
}
