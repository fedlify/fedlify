import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { abortNvflareJob } from "@/lib/nvflare";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const abortSchema = z.object({
  reason: z.string().trim().max(1000).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { jobId } = await context.params;

  const parsed = abortSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid abort request.");

  const job = await prisma.nvflareJob.findUnique({ where: { id: jobId }, include: { study: true } });
  if (!job) return problem(404, "NVFLARE job not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, job.studyId, "abortJob");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (["COMPLETED", "FAILED", "ABORTED", "REJECTED"].includes(job.status)) {
    return problem(409, `Job ${job.status} cannot be aborted.`, "invalid_state");
  }

  const result = await abortNvflareJob({ nvflareJobId: job.nvflareJobId, reason: parsed.data.reason });
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.nvflareJob.update({
      where: { id: jobId },
      data: { status: result.status, completedAt: new Date(), commandSummary: result.summary },
      include: { events: { orderBy: { createdAt: "desc" } }, pipelineVersion: { include: { project: true } } }
    });
    await tx.nvflareJobEvent.create({
      data: {
        jobId,
        studyId: job.studyId,
        eventType: "ABORTED",
        message: result.summary,
        metadata: { reason: parsed.data.reason }
      }
    });
    return next;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: job.study.orgId,
    studyId: job.studyId,
    action: "nvflare.job.abort",
    targetType: "NvflareJob",
    targetId: jobId,
    metadata: { reason: parsed.data.reason },
    request
  });

  return json({ job: updated });
}
