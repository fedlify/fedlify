import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { evaluatePreflight, PREFLIGHT_SITE_PREFIXES, type PreflightItem, type PreflightResult } from "@/lib/preflight";
import { fetchConnectedClients, loadRunContext, runPreflightSnapshot } from "@/lib/preflight-data";
import { checkSiteImages, describeImageMismatch, isImageMismatch, siteImageFixSteps } from "@/lib/site-image";
import { audit } from "@/lib/audit";
import { describeUnreadySites, executionGateMessage } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import { submitNvflareJob } from "@/lib/nvflare";
import { pipelineRunWorkspacePath, prepareNvflareJobWorkspaceForRun, runtimeParametersForSelectedSites } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { buildRunSnapshot, ownClientNames, resolveRunViewer } from "@/lib/run-evidence";
import { adapterSubmitJob, nvflareClientName, StudyRuntimeError } from "@/lib/study-runtime";

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

/** A plain 409 in the usual error shape, with the checklist added under details. */
function problemWithItems(status: number, message: string, code: string, items: PreflightItem[]) {
  return json({ error: { code, message, details: { items } } }, { status });
}

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
      events: { orderBy: { createdAt: "desc" }, take: 20 }
    },
    orderBy: { createdAt: "desc" }
  });

  if (viewer.scope === "full") {
    if (viewer.canViewLogs) return json({ jobs });
    // The server log is for study managers only, the same rule as the run's Logs tab.
    return json({
      jobs: jobs.map(({ logText: _text, logChecksum: _checksum, logTruncated: _truncated, logCapturedAt: _captured, logsStorageKey: _key, ...job }) => job)
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
      events: []
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

  const ctx = await loadRunContext(studyId, { pipelineVersionId: parsed.data.pipelineVersionId, studySiteIds: parsed.data.studySiteIds });
  const { study, pipelineVersion, studySites, deployment } = ctx;

  if (!study) return problem(404, "Study not found.", "not_found");
  if (!pipelineVersion || pipelineVersion.project.studyId !== studyId) {
    return problem(404, "Pipeline version not found for this study.", "pipeline_not_found");
  }

  // The same checklist the screen shows (see lib/preflight.ts), decided in stages: first everything that needs no
  // call to the study server, then which sites are connected.
  const failing = (result: PreflightResult, test: (code: string) => boolean) => result.items.filter((item) => !item.ok && test(item.code));
  const early = evaluatePreflight("run", runPreflightSnapshot(studyId, ctx, { connected: null }));
  const gateItems = failing(early, (code) => code === "ethics" || code === "pipeline_published" || code === "sites" || code.startsWith(PREFLIGHT_SITE_PREFIXES.signedOff));
  if (gateItems.length > 0) {
    const missing: string[] = [];
    for (const item of gateItems) {
      if (item.code === "ethics") missing.push("ethicsApproval");
      else if (item.code === "pipeline_published") {
        if (!pipelineVersion || pipelineVersion.approvalStatus !== "APPROVED") missing.push("approvedPipelineVersion");
        if (pipelineVersion?.validationStatus !== "PASSED") missing.push("passedPipelineValidation");
      } else if (item.code === "sites") missing.push("readySites");
      else if (!missing.includes("allSitesReady")) missing.push("allSitesReady");
    }
    const unreadySites = describeUnreadySites(
      studySites.map((site) => ({ code: site.code, name: site.name, check: site.readinessChecks[0] ?? null }))
    );
    return json(
      {
        error: {
          code: "execution_gate",
          message: executionGateMessage(missing, unreadySites),
          missing,
          unreadySites,
          details: { items: early.items }
        }
      },
      { status: 409 }
    );
  }

  const busyItems = failing(early, (code) => code === "publish_idle" || code === "run_idle");
  if (busyItems.length > 0) {
    const publishing = busyItems.some((item) => item.code === "publish_idle");
    return problemWithItems(
      409,
      publishing ? "A publish is in progress. Wait for it to finish before starting a run." : "A run is already in progress. Wait for it to finish, or stop it, before starting another.",
      publishing ? "publish_in_progress" : "run_in_progress",
      early.items
    );
  }

  if (!deployment?.serverAddress || failing(early, (code) => code === "study_server").length > 0) {
    if (!deployment?.serverAddress) {
      return problemWithItems(409, "Publish the pipeline so the study server is running before starting a run.", "deployment_required", early.items);
    }
    return problemWithItems(409, "The study server is running a different pipeline version. Run that version, or publish this one first.", "version_not_published", early.items);
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

  const publishedRuntime = deployment.runtimeMode === "k8s";
  let full = early;
  if (publishedRuntime) {
    // Connection state comes from the study server itself, not from site heartbeats.
    let connected: Set<string>;
    try {
      connected = await fetchConnectedClients(studyId, deployment);
    } catch (error) {
      if (error instanceof StudyRuntimeError) return problem(error.status, "The study server could not be reached. Try again in a minute.", "aggregator_unreachable");
      throw error;
    }
    full = evaluatePreflight("run", runPreflightSnapshot(studyId, ctx, { connected, minClients: parsed.data.runtimeParameters?.minClients }));
    const offlineItems = failing(full, (code) => code.startsWith(PREFLIGHT_SITE_PREFIXES.connected));
    if (offlineItems.length > 0) {
      const offline = studySites
        .filter((site) => offlineItems.some((item) => item.code === `${PREFLIGHT_SITE_PREFIXES.connected}${site.id}`))
        .map((site) => site.name || site.code);
      return problemWithItems(409, `These sites are not connected to the study server yet: ${offline.join(", ")}.`, "sites_not_connected", full.items);
    }

    // Every selected site must run the study server's code version. The server can move to a new digest (a publish)
    // while a site still runs the old one; submitting then trains on mismatched code.
    if (failing(full, (code) => code.startsWith(PREFLIGHT_SITE_PREFIXES.codeVersion)).length > 0) {
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
      return json(
        {
          error: {
            code: "site_image_mismatch",
            message: describeImageMismatch(checks, deployment.imageDigest),
            sites: outdated.map((check) => ({ code: check.code, clientName: check.clientName, state: check.state, reportedDigest: check.reportedDigest, needsNewKit: check.needsNewKit, fix: siteImageFixSteps(check) })),
            desiredImageDigest: deployment.imageDigest,
            details: { items: full.items }
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
  const minSitesItem = failing(full, (code) => code === "min_sites")[0];
  if ((parsed.data.runtimeParameters?.minClients ?? runtimeParameters.minClients) > selectedSites.length || minSitesItem) {
    return problem(
      400,
      minSitesItem
        ? `${minSitesItem.text}. ${minSitesItem.detail ?? ""}`.trim()
        : `The minimum number of sites cannot be higher than the number of selected sites. Selected ${selectedSites.length}, requested ${parsed.data.runtimeParameters?.minClients}.`,
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
        events: true
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
