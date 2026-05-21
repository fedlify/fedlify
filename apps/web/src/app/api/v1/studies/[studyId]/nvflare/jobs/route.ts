import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { latestEthicsStatus, pipelineExecutionGate } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import { submitNvflareJob } from "@/lib/nvflare";
import { pipelineRunWorkspacePath, prepareNvflareJobWorkspaceForRun, runtimeParametersForSelectedSites } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const submitJobSchema = z.object({
  pipelineVersionId: z.string().min(1),
  studySiteIds: z.array(z.string().min(1)).optional(),
  runtimeParameters: z
    .object({
      minClients: z.coerce.number().int().min(1).optional(),
      numRounds: z.coerce.number().int().min(1).max(1000).optional()
    })
    .optional(),
  commandSummary: z.string().trim().max(2000).optional()
});

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const jobs = await prisma.nvflareJob.findMany({
    where: { studyId },
    include: {
      deployment: true,
      pipelineVersion: { include: { project: true } },
      events: { orderBy: { createdAt: "desc" }, take: 20 },
      logArtifacts: { orderBy: { createdAt: "desc" }, take: 10 }
    },
    orderBy: { createdAt: "desc" }
  });

  return json({ jobs });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "submitJob");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = submitJobSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid NVFLARE job submission.");

  const [study, pipelineVersion] = await Promise.all([
    prisma.study.findUnique({
      where: { id: studyId },
      include: { ethics: { orderBy: { createdAt: "desc" }, take: 1 } }
    }),
    prisma.pipelineVersion.findUnique({
      where: { id: parsed.data.pipelineVersionId },
      include: { project: true }
    })
  ]);

  if (!study) return problem(404, "Study not found.", "not_found");
  if (!pipelineVersion || pipelineVersion.project.studyId !== studyId) {
    return problem(404, "Approved pipeline version not found for this study.", "pipeline_not_found");
  }

  const studySites = await prisma.studySite.findMany({
    where: {
      studyId,
      ...(parsed.data.studySiteIds?.length ? { id: { in: parsed.data.studySiteIds } } : {})
    },
    include: { readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 }, site: true }
  });

  const gate = pipelineExecutionGate({
    ethicsStatus: latestEthicsStatus(study.ethics),
    pipelineApprovalStatus: pipelineVersion.approvalStatus,
    pipelineValidationStatus: pipelineVersion.validationStatus,
    readinessChecks: studySites.map((site) => ({ status: site.readinessChecks[0]?.status ?? "PENDING" }))
  });
  if (!gate.allowed) {
    return problem(409, `NVFLARE job submission is blocked by missing requirements: ${gate.missing.join(", ")}.`, "execution_gate");
  }

  const deployment = await prisma.nvflareDeployment.findFirst({ where: { studyId, active: true, status: "ACTIVE" } });
  if (!deployment?.serverAddress) {
    return problem(409, "Start an active NVFLARE deployment before submitting jobs.", "deployment_required");
  }

  const selectedSites = studySites.map((site) => ({
    studySiteId: site.id,
    siteId: site.siteId,
    code: site.code,
    nvflareClientName: site.site?.nvflareClientName ?? `site-${site.code}`
  }));
  if (selectedSites.length === 0) {
    return problem(409, "Select at least one ready participant site before submitting a job.", "no_selected_sites");
  }

  const runtimeParameters = runtimeParametersForSelectedSites({
    selectedSiteCount: selectedSites.length,
    minClients: parsed.data.runtimeParameters?.minClients,
    numRounds: parsed.data.runtimeParameters?.numRounds
  });
  if ((parsed.data.runtimeParameters?.minClients ?? runtimeParameters.minClients) > selectedSites.length) {
    return problem(
      400,
      `Minimum participating sites cannot exceed selected sites. Selected ${selectedSites.length}, requested ${parsed.data.runtimeParameters?.minClients}.`,
      "invalid_runtime_parameters"
    );
  }

  const created = await prisma.nvflareJob.create({
    data: {
      studyId,
      deploymentId: deployment.id,
      pipelineVersionId: pipelineVersion.id,
      submittedById: authResult.userId,
      selectedSites: selectedSites as Prisma.InputJsonArray,
      commandSummary: parsed.data.commandSummary ?? "Submitted from Fedlify operations dashboard."
    }
  });

  let submitted: Awaited<ReturnType<typeof submitNvflareJob>>;
  try {
    if (!pipelineVersion.jobWorkspacePath) {
      throw new Error("The approved pipeline version does not have a local NVFLARE job workspace path.");
    }
    const runWorkspacePath = pipelineRunWorkspacePath({ studyId, jobId: created.id });
    await prepareNvflareJobWorkspaceForRun({
      sourceWorkspacePath: pipelineVersion.jobWorkspacePath,
      destinationWorkspacePath: runWorkspacePath,
      runtimeParameters
    });
    submitted = await submitNvflareJob({
      fedlifyJobId: created.id,
      pipelineVersionId: pipelineVersion.id,
      selectedSiteCodes: selectedSites.map((site) => site.code),
      deployment,
      gitCommit: pipelineVersion.gitCommit,
      jobWorkspacePath: runWorkspacePath,
      runtimeParameters
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FLARE API submit_job failed.";
    await prisma.$transaction([
      prisma.nvflareJob.update({
        where: { id: created.id },
        data: { status: "FAILED", commandSummary: message, completedAt: new Date() }
      }),
      prisma.nvflareJobEvent.create({
        data: {
          jobId: created.id,
          studyId,
          eventType: "FAILED",
          message,
          metadata: { selectedSites, runtimeParameters } as Prisma.InputJsonObject
        }
      })
    ]);
    return problem(503, message, "flare_api_submit_failed");
  }

  const job = await prisma.$transaction(async (tx) => {
    const updated = await tx.nvflareJob.update({
      where: { id: created.id },
      data: {
        nvflareJobId: submitted.nvflareJobId,
        status: submitted.status,
        commandSummary: submitted.summary,
        submittedAt: new Date()
      },
      include: {
        deployment: true,
        pipelineVersion: { include: { project: true } },
        events: true,
        logArtifacts: true
      }
    });

    await tx.nvflareJobEvent.create({
      data: {
        jobId: updated.id,
        studyId,
        eventType: "SUBMITTED",
        message: submitted.summary,
        metadata: { nvflareJobId: submitted.nvflareJobId, selectedSites, runtimeParameters } as Prisma.InputJsonObject
      }
    });

    return updated;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "nvflare.job.submit",
    targetType: "NvflareJob",
    targetId: job.id,
    metadata: { nvflareJobId: job.nvflareJobId, selectedSites, runtimeParameters },
    request
  });

  return json({ job }, { status: 201 });
}
