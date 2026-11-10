import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { isSitePresent } from "@/lib/site-presence";
import { checkSiteImages, describeImageMismatch, isImageMismatch, siteImageFixSteps } from "@/lib/site-image";
import { audit } from "@/lib/audit";
import { describeUnreadySites, executionGateMessage, latestEthicsStatus, pipelineExecutionGate } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import { submitNvflareJob } from "@/lib/nvflare";
import { pipelineRunWorkspacePath, prepareNvflareJobWorkspaceForRun, runtimeParametersForSelectedSites } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { buildRunSnapshot, ownClientNames, resolveRunViewer } from "@/lib/run-evidence";
import { adapterSubmitJob, adapterSystemInfo, nvflareClientName, StudyRuntimeError } from "@/lib/study-runtime";

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

  const viewer = await resolveRunViewer(authResult.userId, studyId);
  if (!viewer) return problem(403, "You do not have permission to perform this action for this study.", "forbidden");

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

  if (viewer.scope === "full") {
    if (viewer.canViewLogs) return json({ jobs });
    // The server log is for study managers only, the same rule as the run's Logs tab.
    return json({
      jobs: jobs.map(({ logText: _text, logChecksum: _checksum, logTruncated: _truncated, logCapturedAt: _captured, logsStorageKey: _key, logArtifacts: _artifacts, ...job }) => ({ ...job, logArtifacts: [] }))
    });
  }

  // A site operator only sees runs that include one of their own sites, without the other sites' details,
  // the run's event history or its log files.
  // Built from an explicit list so columns added later (round metrics, server log, site-lost details) never leak by default.
  const ownJobs = jobs
    .filter((job) => ownClientNames(job.selectedSites, viewer.ownSiteCodes).size > 0)
    .map((job) => ({
      id: job.id,
      studyId: job.studyId,
      pipelineVersionId: job.pipelineVersionId,
      nvflareJobId: job.nvflareJobId,
      status: job.status,
      commandSummary: job.commandSummary,
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      pipelineVersion: job.pipelineVersion ? { id: job.pipelineVersion.id, version: job.pipelineVersion.version } : null,
      selectedSites: Array.isArray(job.selectedSites)
        ? (job.selectedSites as Array<{ code?: unknown }>).filter((entry) => typeof entry?.code === "string" && viewer.ownSiteCodes.includes(entry.code))
        : [],
      deployment: null,
      siteDigests: null,
      metricsSummary: null,
      events: [],
      logArtifacts: []
    }));
  return json({ jobs: ownJobs });
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
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "The run request is not valid.");

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
    return problem(404, "Pipeline version not found for this study.", "pipeline_not_found");
  }

  const studySites = await prisma.studySite.findMany({
    where: {
      studyId,
      // Same rule as publish: a disabled site neither blocks nor takes part in a run.
      participationStatus: { not: "DISABLED" },
      ...(parsed.data.studySiteIds?.length ? { id: { in: parsed.data.studySiteIds } } : {})
    },
    include: { readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 }, site: { include: { heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, metadata: true } } } } }
  });

  const gate = pipelineExecutionGate({
    ethicsStatus: latestEthicsStatus(study.ethics),
    pipelineApprovalStatus: pipelineVersion.approvalStatus,
    pipelineValidationStatus: pipelineVersion.validationStatus,
    readinessChecks: studySites.map((site) => site.readinessChecks[0] ?? null)
  });
  if (!gate.allowed) {
    const unreadySites = describeUnreadySites(
      studySites.map((site) => ({ code: site.code, name: site.name, check: site.readinessChecks[0] ?? null }))
    );
    return json(
      {
        error: {
          code: "execution_gate",
          message: executionGateMessage(gate.missing, unreadySites),
          missing: gate.missing,
          unreadySites
        }
      },
      { status: 409 }
    );
  }

  const deployment = await prisma.nvflareDeployment.findFirst({ where: { studyId, active: true, status: "ACTIVE" } });
  if (!deployment?.serverAddress) {
    return problem(409, "Publish the pipeline so the study server is running before starting a run.", "deployment_required");
  }

  const publishedRuntime = deployment.runtimeMode === "k8s";
  if (publishedRuntime && deployment.pipelineVersionId !== pipelineVersion.id) {
    return problem(
      409,
      "The study server is running a different pipeline version. Run that version, or publish this one first.",
      "version_not_published"
    );
  }

  const selectedSites = studySites.map((site) => ({
    studySiteId: site.id,
    siteId: site.siteId,
    code: site.code,
    nvflareClientName: site.site?.nvflareClientName ?? `site-${site.code}`
  }));
  if (selectedSites.length === 0) {
    return problem(409, "Select at least one ready site before starting a run.", "no_selected_sites");
  }

  if (publishedRuntime) {
    // Connection state comes from the aggregator itself, not from site heartbeats.
    let connected: Set<string>;
    try {
      connected = new Set((await adapterSystemInfo({ studyId, adapterUrl: deployment.adapterUrl })).clients.map((client) => client.name));
    } catch (error) {
      if (error instanceof StudyRuntimeError) return problem(error.status, "The study server could not be reached. Try again in a minute.", "aggregator_unreachable");
      throw error;
    }
    const offline = studySites
      .filter((site) => !isSitePresent(connected.has(nvflareClientName({ code: site.code, nvflareClientName: site.site?.nvflareClientName })), site.site?.heartbeats[0]?.createdAt))
      .map((site) => site.name || site.code);
    if (offline.length > 0) {
      return problem(409, `These sites are not connected to the study server yet: ${offline.join(", ")}.`, "sites_not_connected");
    }
  }

  if (publishedRuntime) {
    // Every selected site must run the aggregator's image. The aggregator can move to a new digest (a publish) while a
    // site still runs the old one; submitting then trains on mismatched code. Compared by sha256 only; missing counts as a mismatch.
    const checks = checkSiteImages(
      studySites.map((site) => ({
        code: site.code,
        clientName: nvflareClientName({ code: site.code, nvflareClientName: site.site?.nvflareClientName }),
        name: site.name,
        heartbeatMetadata: site.site?.heartbeats[0]?.metadata ?? null
      })),
      deployment.imageDigest
    );
    const outdated = checks.filter((check) => isImageMismatch(check.state));
    if (outdated.length > 0) {
      return json(
        {
          error: {
            code: "site_image_mismatch",
            message: describeImageMismatch(checks, deployment.imageDigest),
            sites: outdated.map((check) => ({ code: check.code, clientName: check.clientName, state: check.state, reportedDigest: check.reportedDigest, needsNewKit: check.needsNewKit, fix: siteImageFixSteps(check) })),
            desiredImageDigest: deployment.imageDigest
          }
        },
        { status: 409 }
      );
    }
  }

  const runtimeParameters = runtimeParametersForSelectedSites({
    selectedSiteCount: selectedSites.length,
    minClients: parsed.data.runtimeParameters?.minClients,
    numRounds: parsed.data.runtimeParameters?.numRounds
  });
  if ((parsed.data.runtimeParameters?.minClients ?? runtimeParameters.minClients) > selectedSites.length) {
    return problem(
      400,
      `The minimum number of sites cannot be higher than the number of selected sites. Selected ${selectedSites.length}, requested ${parsed.data.runtimeParameters?.minClients}.`,
      "invalid_runtime_parameters"
    );
  }

  // Snapshot the evidence now: the pipeline version, aggregator image and site runners can all change after the run.
  const snapshot = buildRunSnapshot({
    pipelineVersion: pipelineVersion,
    deployment,
    sites: studySites.map((site) => ({
      code: site.code,
      nvflareClientName: nvflareClientName({ code: site.code, nvflareClientName: site.site?.nvflareClientName }),
      heartbeatMetadata: site.site?.heartbeats[0]?.metadata ?? null,
      heartbeatAt: site.site?.heartbeats[0]?.createdAt ?? null
    })),
    runtimeParameters
  });

  const created = await prisma.nvflareJob.create({
    data: {
      ...snapshot,
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
    if (publishedRuntime) {
      // The aggregator runs the job baked into the published image; rounds and min clients are set per run.
      const result = await adapterSubmitJob(
        { studyId, adapterUrl: deployment.adapterUrl },
        { jobName: `fedlify-${created.id}`, numRounds: runtimeParameters.numRounds, minClients: runtimeParameters.minClients }
      );
      submitted = {
        nvflareJobId: result.nvflareJobId,
        status: "SUBMITTED",
        summary: `Submitted ${pipelineVersion.version} to ${deployment.hostname} for ${selectedSites.length} site(s); min_clients=${runtimeParameters.minClients}, num_rounds=${runtimeParameters.numRounds}.`
      };
    } else {
      if (!pipelineVersion.jobWorkspacePath) {
        throw new Error("This pipeline version has no run files prepared.");
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
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run could not be started. Try again.";
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
    return problem(503, `The run could not be started. Try again, and contact support if it keeps failing. (Details: ${message})`, "flare_api_submit_failed");
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
