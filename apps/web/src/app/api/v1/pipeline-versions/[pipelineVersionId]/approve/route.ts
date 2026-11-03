import { z } from "zod";
import type { NextRequest } from "next/server";
import { submitPipelineWorkflow } from "@/lib/agent";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const approveSchema = z.object({
  notes: z.string().trim().max(4000).optional()
});

const PIPELINE_CI_PROVIDER = "argo-gitea-publish";

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
  if (!pipelineVersion.project.giteaOwner || !pipelineVersion.project.giteaRepo) {
    return problem(409, "A pipeline version must reference a Gitea repository before approval.", "gitea_repo_required");
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

  let ciRun = await prisma.cIValidationRun.findFirst({
    where: {
      pipelineVersionId,
      provider: PIPELINE_CI_PROVIDER,
      status: { in: ["QUEUED", "RUNNING"] }
    },
    orderBy: { startedAt: "desc" }
  });
  ciRun ??= await prisma.cIValidationRun.create({
    data: {
      pipelineVersionId,
      provider: PIPELINE_CI_PROVIDER,
      status: "QUEUED",
      summary: "Fedlify pipeline publish CI is queued."
    }
  });

  let ciSubmissionError: string | null = null;
  try {
    const submitted = await submitPipelineWorkflow({
      pipelineVersionId,
      ciRunId: ciRun.id,
      studyId: pipelineVersion.project.studyId,
      giteaOwner: pipelineVersion.project.giteaOwner,
      giteaRepo: pipelineVersion.project.giteaRepo,
      gitCommit: pipelineVersion.gitCommit,
      gitopsPath: `studies/${pipelineVersion.project.study.slug}/pipelines/${pipelineVersion.project.giteaRepo}`
    });
    ciRun = await prisma.cIValidationRun.update({
      where: { id: ciRun.id },
      data: {
        workflowId: submitted.workflowId,
        status: submitted.submitted ? "QUEUED" : "PASSED",
        summary: submitted.submitted
          ? "Fedlify submitted the approved Gitea commit to Argo Workflows."
          : "Local development no-op: Argo Workflow submission skipped outside Kubernetes.",
        completedAt: submitted.submitted ? null : new Date()
      }
    });
    if (submitted.submitted) {
      await prisma.pipelineVersion.update({ where: { id: pipelineVersionId }, data: { validationStatus: "QUEUED" } });
    }
  } catch (error) {
    ciSubmissionError = error instanceof Error ? error.message : "Argo Workflow submission failed.";
    ciRun = await prisma.cIValidationRun.update({
      where: { id: ciRun.id },
      data: {
        status: "FAILED",
        summary: ciSubmissionError,
        completedAt: new Date()
      }
    });
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: pipelineVersion.project.study.orgId,
    studyId: pipelineVersion.project.studyId,
    action: "pipeline.version.approve",
    targetType: "PipelineVersion",
    targetId: pipelineVersionId,
    metadata: {
      version: pipelineVersion.version,
      gitCommit: pipelineVersion.gitCommit,
      notes: parsed.data.notes,
      ciRunId: ciRun.id,
      ciWorkflowId: ciRun.workflowId,
      ciSubmissionError
    },
    request
  });

  return json({ pipelineVersion: updated, ciRun, ciSubmissionError });
}
