/**
 * /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads
 *
 * GET:  list threads (own; managers and auditors see all, auditors without titles). Cursor paged.
 * POST: create an empty thread. Needs read + runAgent. 404 threads_disabled when AGENT_THREADS_ENABLED is off.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { auditThread, openThreadRoute } from "@/lib/agent-thread-route";
import { createThread, listThreads, threadSummaryDto } from "@/lib/agent-thread-store";
import { AUDIT_ACTIONS, THREAD_MODES } from "@/lib/agent-thread-types";

type Params = { params: Promise<{ studyId: string; projectId: string }> };

const createSchema = z.object({
  message: z.string().trim().max(8000).optional(),
  mode: z.enum(THREAD_MODES).optional()
});

export async function GET(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId });
  if (!ctx.ok) return ctx.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "ARCHIVED" || statusParam === "ACTIVE" ? statusParam : undefined;
  const sees_all = ctx.actor.canManage || ctx.actor.canAudit;
  // The audit role sees metadata only, so it cannot search by title either.
  const auditorOnly = !ctx.actor.canUse && !ctx.actor.canManage;
  const page = await listThreads({
    projectId,
    viewerId: authResult.userId,
    scope: sees_all ? "all" : "own",
    status,
    q: auditorOnly ? undefined : (url.searchParams.get("q") ?? undefined),
    cursor: url.searchParams.get("cursor") ?? undefined
  });
  return json({
    threads: page.rows.filter((row): row is NonNullable<typeof row> => row !== null).map((row) => threadSummaryDto(row, authResult.userId, { redactTitle: auditorOnly && row.createdById !== authResult.userId })),
    nextCursor: page.nextCursor
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId });
  if (!ctx.ok) return ctx.response;
  if (!ctx.actor.canUse) return problem(403, "You do not have permission to use the assistant for this study.", "forbidden");

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid thread request.");

  const created = await createThread({ projectId, studyId, createdById: authResult.userId, firstMessage: parsed.data.message, mode: parsed.data.mode });
  await auditThread({
    request,
    userId: authResult.userId,
    orgId: ctx.project.study.orgId,
    studyId,
    projectId,
    action: AUDIT_ACTIONS.threadCreate,
    metadata: { threadId: created.id, mode: created.mode }
  });
  return json({ thread: threadSummaryDto({ ...created, createdBy: { id: authResult.userId, name: null } }, authResult.userId) }, { status: 201 });
}
