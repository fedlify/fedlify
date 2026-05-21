import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const approveSchema = z.object({
  notes: z.string().trim().max(4000).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ pipelineVersionId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { pipelineVersionId } = await context.params;

  const parsed = approveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid pipeline approval.");

  const pipelineVersion = await prisma.pipelineVersion.findUnique({
    where: { id: pipelineVersionId },
    include: { project: { include: { study: true } }, ciRuns: { orderBy: { startedAt: "desc" }, take: 1 } }
  });
  if (!pipelineVersion) return problem(404, "Pipeline version not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, pipelineVersion.project.studyId, "approvePipeline");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (!pipelineVersion.gitCommit) {
    return problem(409, "A pipeline version must reference a Git commit before approval.", "git_commit_required");
  }
  if (pipelineVersion.validationStatus !== "PASSED") {
    return problem(409, "A pipeline version must pass CI validation before approval.", "validation_required");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const version = await tx.pipelineVersion.update({
      where: { id: pipelineVersionId },
      data: {
        approvalStatus: "APPROVED",
        approvedById: authResult.userId,
        approvedAt: new Date(),
        immutable: true
      }
    });
    await tx.pipelineProject.update({ where: { id: pipelineVersion.projectId }, data: { status: "APPROVED" } });
    return version;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: pipelineVersion.project.study.orgId,
    studyId: pipelineVersion.project.studyId,
    action: "pipeline.version.approve",
    targetType: "PipelineVersion",
    targetId: pipelineVersionId,
    metadata: { version: pipelineVersion.version, gitCommit: pipelineVersion.gitCommit, notes: parsed.data.notes },
    request
  });

  return json({ pipelineVersion: updated });
}
