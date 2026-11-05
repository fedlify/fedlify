import { Prisma } from "@prisma/client";
import { unzipToArchiveMap } from "@/lib/archive";
import { sha256 } from "@/lib/crypto";
import { redactLogText } from "@/lib/log-redact";
import { prisma } from "@/lib/prisma";
import { parseRoundMetricsJsonl, recordsToJsonl, summarizeMetrics } from "@/lib/round-metrics";
import { adapterJobLog, adapterJobMetrics, adapterJobResultZip } from "@/lib/study-runtime";

/** What capture needs to know about a run. Extra fields on the caller's object are fine. */
export type CapturableJob = {
  id: string;
  studyId: string;
  nvflareJobId: string | null;
  metricsJsonl?: string | null;
  logChecksum?: string | null;
  deployment: { runtimeMode: string | null; adapterUrl: string | null } | null;
};

/**
 * Copies the aggregator's per-round metrics onto the job (once). Best effort: an unreachable aggregator or an empty
 * file stores nothing, and the run page then says the metrics are missing. Never overwrites captured evidence.
 */
export async function captureRunMetrics(job: CapturableJob): Promise<boolean> {
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

/** The adapter's `/log` endpoint first; an older adapter (404) or a failure falls back to log.txt inside the result archive. */
async function fetchServerLog(job: CapturableJob & { nvflareJobId: string; deployment: { adapterUrl: string | null } }): Promise<string> {
  const target = { studyId: job.studyId, adapterUrl: job.deployment.adapterUrl };
  try {
    return await adapterJobLog(target, job.nvflareJobId);
  } catch {
    const files = await unzipToArchiveMap(await adapterJobResultZip(target, job.nvflareJobId));
    const name = Object.keys(files)
      .filter((key) => key === "log.txt" || key.endsWith("/log.txt"))
      .sort((a, b) => a.length - b.length)[0];
    if (!name) throw new Error("no log.txt in the result archive");
    return Buffer.from(files[name]).toString("utf8");
  }
}

/**
 * Copies the aggregator's server log onto the job (once), redacted and size-capped exactly like the stored-result log,
 * with the checksum of the text as stored. Runs whenever a run ends (COMPLETED, FAILED, ABORTED) and, for an abort,
 * BEFORE the abort call, while the aggregator workspace still exists. Best effort; never overwrites a captured log.
 */
export async function captureRunLog(job: CapturableJob): Promise<boolean> {
  if (job.logChecksum || !job.nvflareJobId || job.deployment?.runtimeMode !== "k8s") return false;
  try {
    const raw = await fetchServerLog({ ...job, nvflareJobId: job.nvflareJobId, deployment: job.deployment });
    if (!raw.trim()) return false;
    const { text, truncated } = redactLogText(raw);
    const done = await prisma.nvflareJob.updateMany({
      where: { id: job.id, logChecksum: null },
      data: { logText: text, logChecksum: sha256(Buffer.from(text, "utf8")), logTruncated: truncated, logCapturedAt: new Date() }
    });
    return done.count > 0;
  } catch {
    return false;
  }
}

/**
 * Undoes a capture made by THIS abort attempt (stamped at or after `since`) when the abort then fails: that capture is a
 * mid-run snapshot, and leaving it would block the real capture at the terminal transition (capture never overwrites).
 * Captures from earlier calls are not touched.
 */
export async function discardCaptureSince(jobId: string, since: Date): Promise<void> {
  try {
    await prisma.nvflareJob.updateMany({ where: { id: jobId, logCapturedAt: { gte: since } }, data: { logText: null, logChecksum: null, logTruncated: null, logCapturedAt: null } });
    await prisma.nvflareJob.updateMany({
      where: { id: jobId, metricsCapturedAt: { gte: since } },
      data: { metricsJsonl: null, metricsChecksum: null, metricsCapturedAt: null, metricsSummary: Prisma.DbNull }
    });
  } catch {
    // best effort
  }
}
