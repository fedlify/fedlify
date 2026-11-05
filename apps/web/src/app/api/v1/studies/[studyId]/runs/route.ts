/**
 * GET /api/v1/studies/[studyId]/runs
 *
 * One row per run for the Results table. Requires study read access. A site operator only sees runs that include
 * one of their own sites, and never the cross-site aggregate (best AUROC).
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { ownClientNames, resolveRunViewer } from "@/lib/run-evidence";
import { reconcileRun } from "@/lib/run-reconcile";
import { readMetricsSummary } from "@/lib/round-metrics";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  const viewer = await resolveRunViewer(authResult.userId, studyId);
  if (!viewer) return problem(403, "You do not have permission to perform this action for this study.", "forbidden");

  const jobs = await prisma.nvflareJob.findMany({
    where: { studyId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      status: true,
      nvflareJobId: true,
      createdAt: true,
      submittedAt: true,
      completedAt: true,
      gitCommit: true,
      imageDigest: true,
      studyId: true,
      selectedSites: true,
      metricsSummary: true,
      deployment: { select: { runtimeMode: true, adapterUrl: true } },
      pipelineVersion: { select: { version: true, gitCommit: true } },
      result: { select: { id: true, modelRelease: { select: { id: true, version: true, status: true } } } }
    }
  });

  // Active runs are synced with NVFLARE here too, so the table does not show a finished run as running.
  const active = jobs.filter((job) => ["SUBMITTED", "SCHEDULED", "RUNNING"].includes(job.status)).slice(0, 10);
  const reconciled = new Map((await Promise.all(active.map(async (job) => [job.id, await reconcileRun(job)] as const))));

  const visible = viewer.scope === "full" ? jobs : jobs.filter((job) => ownClientNames(job.selectedSites, viewer.ownSiteCodes).size > 0);
  const runs = visible.map((job) => {
    const summary = viewer.scope === "full" ? readMetricsSummary(job.metricsSummary) : null;
    return {
      id: job.id,
      status: reconciled.get(job.id)?.status ?? job.status,
      nvflareJobId: job.nvflareJobId,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      pipelineVersion: job.pipelineVersion.version,
      gitCommit: job.gitCommit ?? job.pipelineVersion.gitCommit ?? null,
      gitCommitRecordedOnRun: Boolean(job.gitCommit),
      imageDigest: job.imageDigest ?? null,
      // Best of the stored round averages for the key metric. null = no stored metrics (or hidden from this viewer).
      bestAuroc: summary?.best?.key === "auroc" ? { value: summary.best.value, round: summary.best.round } : null,
      metricsStored: viewer.scope === "full" ? summary !== null : null,
      modelSaved: Boolean(job.result),
      modelRelease: job.result?.modelRelease ? { version: job.result.modelRelease.version, status: job.result.modelRelease.status } : null
    };
  });
  return json({ runs, scope: viewer.scope }, { headers: { "Cache-Control": "no-store" } });
}
