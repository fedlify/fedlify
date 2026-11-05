import type { NvflareJobStatus } from "@prisma/client";
import { abortNvflareJob } from "@/lib/nvflare";
import { captureRunLog, captureRunMetrics, discardCaptureSince, type CapturableJob } from "@/lib/run-capture";
import { adapterAbortJob } from "@/lib/study-runtime";

export type AbortableJob = CapturableJob & { deployment: { runtimeMode: string | null; adapterUrl: string | null; hostname?: string | null } | null };

/**
 * The one abort path (the abort route and the site-lost timeout both use it). Evidence is captured FIRST: once the
 * aggregator aborts a job its run workspace can be cleaned up, and the server log and round metrics would be gone.
 * Throws if the aggregator cannot be reached; the caller then leaves the run's recorded status alone.
 */
export async function abortRunOnAggregator(job: AbortableJob, reason?: string): Promise<{ status: NvflareJobStatus; summary: string }> {
  if (job.deployment?.runtimeMode === "k8s") {
    const startedAt = new Date();
    await captureRunLog(job);
    await captureRunMetrics(job);
    if (job.nvflareJobId) {
      try {
        await adapterAbortJob({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl }, job.nvflareJobId);
      } catch (error) {
        // The run was not aborted, so the pre-abort snapshot is not final: drop it so the terminal transition captures the real log.
        await discardCaptureSince(job.id, startedAt);
        throw error;
      }
    }
    return {
      status: "ABORTED",
      summary: `Abort requested on ${job.deployment.hostname} for ${job.nvflareJobId ?? "unsubmitted job"}${reason ? `: ${reason}` : "."}`
    };
  }
  return abortNvflareJob({ nvflareJobId: job.nvflareJobId, reason });
}
