import type { NvflareJobStatus, Prisma } from "@prisma/client";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { parseRoundMetricsJsonl, recordsToJsonl, summarizeMetrics } from "@/lib/round-metrics";
import { adapterJobMeta, adapterJobMetrics, fedlifyJobStatus } from "@/lib/study-runtime";

const ACTIVE = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED", "REJECTED"]);

export type ReconcilableJob = {
  id: string;
  studyId: string;
  status: string;
  nvflareJobId: string | null;
  metricsJsonl?: string | null;
  deployment: { runtimeMode: string | null; adapterUrl: string | null } | null;
};

/**
 * Copies the aggregator's per-round metrics onto the job (once). Best effort: an unreachable aggregator or an empty
 * file stores nothing, and the run page then says the metrics are missing. Never overwrites captured evidence.
 */
export async function captureRunMetrics(job: ReconcilableJob): Promise<boolean> {
  if (job.metricsJsonl || !job.nvflareJobId || job.deployment?.runtimeMode !== "k8s") return false;
  try {
    const live = await adapterJobMetrics({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl }, job.nvflareJobId);
    if (!live.records.length) return false;
    const text = recordsToJsonl(live.records);
    // updateMany with a null guard so a concurrent capture cannot be overwritten.
    const done = await prisma.nvflareJob.updateMany({
      where: { id: job.id, metricsJsonl: null },
      data: { metricsJsonl: text, metricsChecksum: sha256(Buffer.from(text)), metricsCapturedAt: new Date(), metricsSummary: summarizeMetrics(parseRoundMetricsJsonl(text)) as unknown as Prisma.InputJsonObject }
    });
    return done.count > 0;
  } catch {
    return false;
  }
}

/**
 * Moves an active published-runtime job to the status NVFLARE reports and, at the transition to a terminal status,
 * captures the round metrics. Also back-fills metrics for a terminal job that has none while the aggregator still
 * holds them (older runs, runs nobody watched). Returns the status now on record.
 */
export async function reconcileRun(job: ReconcilableJob): Promise<{ status: string; metricsCaptured: boolean }> {
  let status = job.status;
  if (job.deployment?.runtimeMode === "k8s" && job.nvflareJobId && ACTIVE.has(job.status)) {
    try {
      const meta = await adapterJobMeta({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl }, job.nvflareJobId);
      const next = fedlifyJobStatus(meta.status);
      if (next !== job.status) {
        const moved = await prisma.nvflareJob.updateMany({
          where: { id: job.id, status: job.status as NvflareJobStatus },
          data: { status: next, ...(TERMINAL.has(next) ? { completedAt: new Date() } : {}) }
        });
        if (moved.count > 0) {
          await prisma.nvflareJobEvent.create({
            data: { jobId: job.id, studyId: job.studyId, eventType: next === "RUNNING" ? "STARTED" : next, message: `NVFLARE reports ${meta.status}.`, metadata: { nvflareStatus: meta.status } as Prisma.InputJsonObject }
          });
        }
        status = next;
      }
    } catch {
      // Aggregator unreachable: leave the recorded status alone.
    }
  }
  const metricsCaptured = TERMINAL.has(status) ? await captureRunMetrics({ ...job, status }) : false;
  return { status, metricsCaptured };
}
