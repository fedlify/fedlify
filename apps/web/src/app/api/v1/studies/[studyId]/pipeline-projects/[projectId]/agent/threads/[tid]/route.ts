/**
 * /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/threads/[tid]
 *
 * GET:   the thread with turns, plans and proposal summaries (?after=seq for newer turns). The author and managers
 *        (read-only) get content; the audit role gets metadata only. Reading someone else's thread is audited.
 * PATCH: rename or archive/unarchive (author or manager).
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { auditThread, openThreadRoute } from "@/lib/agent-thread-route";
import { loadThreadDetail, renameThread, setThreadStatus, threadSummaryDto } from "@/lib/agent-thread-store";
import { AUDIT_ACTIONS, type ThreadMetadataDto } from "@/lib/agent-thread-types";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string }> };

const patchSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), status: z.enum(["ACTIVE", "ARCHIVED"]).optional() })
  .refine((value) => value.title !== undefined || value.status !== undefined, { message: "Nothing to change." });

export async function GET(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const { thread, access } = ctx;
  if (!thread || !access) return problem(404, "Thread not found.", "not_found");

  if (!access.canReadContent) {
    const accessDto = { level: access.level, readOnly: access.readOnly, canDecidePlan: access.canDecidePlan, canArchive: access.canArchive };
    const body: ThreadMetadataDto = { thread: threadSummaryDto(thread, authResult.userId, { redactTitle: true }), access: accessDto, metadataOnly: true };
    return json(body);
  }

  const after = Number(new URL(request.url).searchParams.get("after"));
  const detail = await loadThreadDetail({ thread, viewerId: authResult.userId, access, afterSeq: Number.isInteger(after) && after > 0 ? after : undefined });
  if (access.level !== "author") {
    await auditThread({
      request,
      userId: authResult.userId,
      orgId: ctx.project.study.orgId,
      studyId,
      projectId,
      action: AUDIT_ACTIONS.threadViewOther,
      metadata: { threadId: thread.id, authorId: thread.createdById, level: access.level }
    });
  }
  return json(detail);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const { thread, access } = ctx;
  if (!thread || !access) return problem(404, "Thread not found.", "not_found");
  if (!access.canArchive) return problem(403, "You cannot change this thread.", "forbidden");

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid thread update.");

  if (parsed.data.title !== undefined) {
    await renameThread(thread.id, parsed.data.title);
    if (access.level !== "author") {
      await auditThread({
        request,
        userId: authResult.userId,
        orgId: ctx.project.study.orgId,
        studyId,
        projectId,
        action: AUDIT_ACTIONS.threadRename,
        metadata: { threadId: thread.id, authorId: thread.createdById, level: access.level }
      });
    }
  }
  if (parsed.data.status !== undefined && parsed.data.status !== thread.status) {
    await setThreadStatus(thread.id, parsed.data.status);
    await auditThread({
      request,
      userId: authResult.userId,
      orgId: ctx.project.study.orgId,
      studyId,
      projectId,
      action: AUDIT_ACTIONS.threadArchive,
      metadata: { threadId: thread.id, archived: parsed.data.status === "ARCHIVED", authorId: thread.createdById }
    });
  }
  return json({ ok: true });
}
