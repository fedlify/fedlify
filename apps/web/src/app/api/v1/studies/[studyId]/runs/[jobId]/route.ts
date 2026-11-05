/**
 * GET /api/v1/studies/[studyId]/runs/[jobId]
 *
 * Run detail: summary, stored round metrics, model state. Requires study read access and scopes the response to the
 * viewer: a site operator gets only their own sites' metric rows, and no events, logs or model card.
 * Metrics come from the stored ROUND_METRICS artifact; only a run with nothing stored and still active falls back to
 * the aggregator's live file. Missing data is reported as missing.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { redactMetadata } from "@/lib/audit-query";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { METRICS_DISCLAIMER, parseRoundMetricsJsonl, readMetricsSummary, recordsToJsonl, scopeRoundMetrics, summarizeMetrics } from "@/lib/round-metrics";
import { ownClientNames, resolveRunViewer } from "@/lib/run-evidence";
import { reconcileRun } from "@/lib/run-reconcile";
import { readObject } from "@/lib/storage";
import { adapterJobMetrics } from "@/lib/study-runtime";

type Params = { params: Promise<{ studyId: string; jobId: string }> };
const ACTIVE = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const jobInclude = {
  submittedBy: { select: { name: true } },
  deployment: { select: { runtimeMode: true, adapterUrl: true, hostname: true } },
  pipelineVersion: { include: { project: { select: { id: true, name: true, giteaRepoUrl: true } } } },
  result: { include: { artifacts: true, modelRelease: { include: { artifacts: true, approvedBy: { select: { name: true } } } } } }
} as const;

async function loadMetrics(job: {
  status: string;
  nvflareJobId: string | null;
  studyId: string;
  deployment: { runtimeMode: string | null; adapterUrl: string | null } | null;
  metricsJsonl?: string | null;
  metricsChecksum?: string | null;
  result: { artifacts: Array<{ kind: string; storageKey: string; checksum: string }> } | null;
}): Promise<{ status: "stored" | "live" | "missing" | "unavailable"; reason?: string; checksum?: string; text?: string }> {
  const stored = job.result?.artifacts.find((artifact) => artifact.kind === "ROUND_METRICS");
  if (stored) {
    try {
      const body = await readObject(stored.storageKey);
      if (sha256(body) !== stored.checksum) return { status: "unavailable", reason: "The stored metrics file does not match the checksum recorded at sync time, so it is not shown." };
      return { status: "stored", checksum: stored.checksum, text: body.toString("utf8") };
    } catch {
      return { status: "unavailable", reason: "The stored metrics file could not be read from object storage." };
    }
  }
  if (job.metricsJsonl) {
    // Captured from the aggregator when the run ended (also for runs that failed or were never saved).
    if (job.metricsChecksum && sha256(Buffer.from(job.metricsJsonl)) !== job.metricsChecksum) return { status: "unavailable", reason: "The captured metrics do not match the checksum recorded at capture time, so they are not shown." };
    return { status: "stored", checksum: job.metricsChecksum ?? undefined, text: job.metricsJsonl };
  }
  if (ACTIVE.has(job.status) && job.nvflareJobId && job.deployment?.runtimeMode === "k8s") {
    try {
      const live = await adapterJobMetrics({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl }, job.nvflareJobId);
      return { status: "live", text: recordsToJsonl(live.records) };
    } catch {
      return { status: "unavailable", reason: "The run is active but the aggregator could not be reached for live metrics." };
    }
  }
  return { status: "missing", reason: job.result ? "No round metrics file was stored with this run's result." : "No round metrics were captured for this run, and it has no saved result. Runs from before metrics were stored have none." };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, jobId } = await params;

  const viewer = await resolveRunViewer(authResult.userId, studyId);
  if (!viewer) return problem(403, "You do not have permission to perform this action for this study.", "forbidden");

  const lookup = { where: { id: jobId, studyId }, include: jobInclude };
  let job = await prisma.nvflareJob.findFirst(lookup);
  if (!job) return problem(404, "Run not found.", "not_found");

  // Status and metrics must not depend on someone having the projects page open: sync with NVFLARE and capture metrics here.
  const reconciled = await reconcileRun(job);
  if (reconciled.status !== job.status || reconciled.metricsCaptured || reconciled.logCaptured) job = (await prisma.nvflareJob.findFirst(lookup)) ?? job;

  // A lost-site warning belongs to the run page; a site operator sees only their own sites in it.
  const siteLost = reconciled.siteLost
    ? { ...reconciled.siteLost, sites: reconciled.siteLost.sites.filter((site) => viewer.scope === "full" || viewer.ownSiteCodes.includes(site.code)) }
    : null;

  const own = viewer.scope === "site" ? ownClientNames(job.selectedSites, viewer.ownSiteCodes) : null;
  if (own && own.size === 0) return problem(403, "This run does not include one of your sites.", "forbidden");

  const loaded = await loadMetrics(job);
  let metrics: unknown = { status: loaded.status, reason: loaded.reason ?? null, disclaimer: METRICS_DISCLAIMER };
  if (loaded.text !== undefined) {
    const scoped = scopeRoundMetrics(parseRoundMetricsJsonl(loaded.text), own);
    metrics = {
      status: scoped.recordCount === 0 ? "empty" : loaded.status,
      source: loaded.status,
      reason: scoped.recordCount === 0 ? "The metrics file is present but has no records." : null,
      checksum: loaded.checksum ?? null,
      disclaimer: METRICS_DISCLAIMER,
      rounds: scoped.rounds,
      metricKeys: scoped.metricKeys,
      sites: scoped.sites,
      malformedLines: scoped.malformedLines,
      droppedValues: scoped.droppedValues,
      aggregateHidden: scoped.aggregateHidden,
      summary: own ? null : summarizeMetrics(scoped)
    };
  }

  const selected = Array.isArray(job.selectedSites) ? (job.selectedSites as Array<{ code?: string; nvflareClientName?: string }>) : [];
  const visibleSites = own ? selected.filter((s) => typeof s.code === "string" && viewer.ownSiteCodes.includes(s.code)) : selected;
  const release = job.result?.modelRelease ?? null;
  const events = viewer.canAudit
    ? await prisma.nvflareJobEvent.findMany({ where: { jobId: job.id, studyId }, orderBy: { createdAt: "asc" }, take: 500 })
    : [];

  return json(
    {
      scope: viewer.scope,
      can: { logs: viewer.canViewLogs, audit: viewer.canAudit, saveModel: viewer.canSaveModel, release: viewer.canRelease, modelCard: viewer.scope === "full" },
      run: {
        id: job.id,
        status: job.status,
        nvflareJobId: job.nvflareJobId,
        createdAt: job.createdAt,
        submittedAt: job.submittedAt,
        completedAt: job.completedAt,
        // Why a FAILED or ABORTED run ended (for example the lost sites), for people who see the whole run.
        endReason: viewer.scope === "full" && (job.status === "FAILED" || job.status === "ABORTED") ? (job.commandSummary ?? null) : null,
        submittedBy: viewer.scope === "full" ? (job.submittedBy.name ?? null) : null,
        sites: visibleSites.map((s) => ({ code: s.code, clientName: s.nvflareClientName ?? null })),
        siteCount: selected.length,
        parameters: job.runParameters ?? null,
        pipeline: {
          versionId: job.pipelineVersionId,
          version: job.pipelineVersion.version,
          project: job.pipelineVersion.project.name,
          approvalStatus: job.pipelineVersion.approvalStatus,
          validationStatus: job.pipelineVersion.validationStatus
        },
        snapshot: {
          gitCommit: job.gitCommit ?? null,
          imageDigest: job.imageDigest ?? null,
          siteDigests: viewer.scope === "full" ? (job.siteDigests ?? null) : null,
          recorded: Boolean(job.gitCommit || job.imageDigest || job.runParameters)
        }
      },
      siteLost: siteLost && siteLost.sites.length > 0 ? siteLost : null,
      metrics,
      listSummary: own ? null : readMetricsSummary(job.metricsSummary),
      model: {
        saved: Boolean(job.result),
        resultId: job.result?.id ?? null,
        release: release ? { id: release.id, version: release.version, status: release.status, approvedAt: release.approvedAt, approvedBy: release.approvedBy?.name ?? null, checksum: release.checksum, releaseNotes: release.releaseNotes } : null,
        artifacts: viewer.scope === "full" ? (release?.artifacts ?? job.result?.artifacts ?? []).map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, sizeBytes: a.sizeBytes, checksum: a.checksum })) : []
      },
      events: events.map((e) => ({ id: e.id, createdAt: e.createdAt, type: e.eventType, message: e.message, studySiteId: e.studySiteId, metadata: redactMetadata(e.metadata) }))
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
