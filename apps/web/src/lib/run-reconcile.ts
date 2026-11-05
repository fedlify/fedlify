import { Prisma, type NvflareJobStatus } from "@prisma/client";
import { captureRunLog, captureRunMetrics, type CapturableJob } from "@/lib/run-capture";
import { abortRunOnAggregator } from "@/lib/run-abort";
import { prisma } from "@/lib/prisma";
import { decideSiteLost, type LostSiteEntry, type SiteSignal, siteLostMaxGapMs, siteLostReason, siteLostTimeoutMs } from "@/lib/site-lost";
import { adapterJobMeta, adapterSystemInfo, fedlifyJobStatus, nvflareClientName } from "@/lib/study-runtime";

export { captureRunLog, captureRunMetrics };

const ACTIVE = new Set(["SUBMITTED", "SCHEDULED", "RUNNING"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED", "REJECTED"]);

export type ReconcilableJob = CapturableJob & {
  status: string;
  selectedSites?: unknown;
  siteLostSince?: Date | null;
  siteLostSeenAt?: Date | null;
  siteLostSites?: unknown;
};

/** What the run page shows while a site is lost. `abortAt` is set only for a site that is "down" (the only state that can abort). */
export type SiteLostView = {
  since: string;
  timeoutMs: number;
  sites: Array<{ code: string; clientName: string; state: string; reason: string; since: string; abortAt: string | null }>;
};

export function siteLostView(entries: LostSiteEntry[], timeoutMs = siteLostTimeoutMs()): SiteLostView | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.since.localeCompare(b.since));
  return {
    since: sorted[0].since,
    timeoutMs,
    sites: entries.map((entry) => ({ ...entry, abortAt: entry.state === "down" ? new Date(new Date(entry.since).getTime() + timeoutMs).toISOString() : null }))
  };
}

function storedEntries(value: unknown): LostSiteEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is LostSiteEntry => Boolean(entry) && typeof entry === "object" && typeof (entry as LostSiteEntry).code === "string" && typeof (entry as LostSiteEntry).since === "string" && typeof (entry as LostSiteEntry).state === "string"
  );
}

type SelectedSite = { code: string; nvflareClientName?: string | null; siteId?: string | null };

/**
 * Looks for a participating site that stopped while the run is RUNNING, from two stored/observed signals: each site's
 * latest heartbeat and the aggregator's client list. Shows a warning (persisted on the job plus a run event), and after
 * `FEDLIFY_SITE_LOST_TIMEOUT_MS` of a site being continuously down aborts the run through the shared abort path and
 * ends it FAILED with the lost sites named.
 *
 * Safety: an unreadable aggregator or any error skips the whole evaluation (nothing is warned, cleared or aborted, and
 * the stored `seenAt` is not refreshed, so the continuity rule restarts the clock after a long outage). One observation
 * can never abort: the abort needs a stored episode older than the timeout with no evaluation gap beyond the limit.
 */
export async function evaluateSiteLoss(job: ReconcilableJob, now = Date.now()): Promise<{ view: SiteLostView | null; aborted: boolean }> {
  const none = { view: null, aborted: false };
  try {
    if (job.status !== "RUNNING" || !job.nvflareJobId || job.deployment?.runtimeMode !== "k8s" || !Array.isArray(job.selectedSites)) return none;
    const selected = (job.selectedSites as SelectedSite[]).filter((site) => site && typeof site.code === "string");
    if (selected.length === 0) return none;

    // The aggregator's view first: if it cannot be read, nothing below may conclude anything.
    const listed = new Set((await adapterSystemInfo({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl })).clients.map((client) => client.name));
    const siteIds = selected.map((site) => site.siteId).filter((id): id is string => typeof id === "string");
    const rows = siteIds.length
      ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, status: true } } } })
      : [];
    const heartbeats = new Map(rows.map((row) => [row.id, row.heartbeats[0] ?? null]));
    const signals: SiteSignal[] = selected.map((site) => {
      const clientName = nvflareClientName({ code: site.code, nvflareClientName: site.nvflareClientName });
      const beat = site.siteId ? (heartbeats.get(site.siteId) ?? null) : null;
      return { code: site.code, clientName, listedByAggregator: listed.has(clientName), lastHeartbeatAt: beat?.createdAt ?? null, lastHeartbeatStatus: beat?.status ?? null };
    });

    const previousEntries = storedEntries(job.siteLostSites);
    const timeoutMs = siteLostTimeoutMs();
    const decision = decideSiteLost({
      signals,
      previous: previousEntries.length || job.siteLostSince ? { entries: previousEntries, seenAt: job.siteLostSeenAt ?? null } : null,
      now,
      timeoutMs,
      maxGapMs: siteLostMaxGapMs()
    });

    if (decision.entries.length === 0) {
      if (decision.recovered || job.siteLostSince) {
        const cleared = await prisma.nvflareJob.updateMany({ where: { id: job.id, status: "RUNNING", NOT: { siteLostSince: null } }, data: { siteLostSince: null, siteLostSeenAt: null, siteLostSites: Prisma.DbNull } });
        if (cleared.count > 0 && decision.recovered) {
          await prisma.nvflareJobEvent.create({ data: { jobId: job.id, studyId: job.studyId, eventType: "SITE_UPDATE", message: "All participating sites are reachable again.", metadata: { kind: "site_recovered" } } });
        }
      }
      return none;
    }

    const view = siteLostView(decision.entries, timeoutMs);
    const earliest = new Date(view!.since);
    await prisma.nvflareJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { siteLostSince: earliest, siteLostSeenAt: new Date(now), siteLostSites: decision.entries as unknown as Prisma.InputJsonArray }
    });
    if (decision.newlyAffected.length > 0) {
      const affected = decision.entries.filter((entry) => decision.newlyAffected.includes(entry.code));
      await prisma.nvflareJobEvent.create({
        data: {
          jobId: job.id,
          studyId: job.studyId,
          eventType: "SITE_UPDATE",
          message: `Warning: ${affected.map((entry) => `${entry.clientName} (${entry.reason})`).join("; ")}. A site that stays down for ${Math.round(timeoutMs / 60_000)} minute(s) ends the run as FAILED.`,
          metadata: { kind: "site_lost_warning", sites: affected.map((entry) => ({ code: entry.code, clientName: entry.clientName, state: entry.state })), timeoutMs } as Prisma.InputJsonObject
        }
      });
    }

    if (decision.abortFor.length === 0) return { view, aborted: false };

    // Timeout reached. Same abort path as the abort route: evidence is captured, then the aggregator aborts the job.
    const reason = siteLostReason(decision.abortFor, timeoutMs);
    try {
      await abortRunOnAggregator(job, reason);
    } catch {
      return { view, aborted: false }; // aggregator unreadable or refused: keep RUNNING and try again on the next evaluation
    }
    const moved = await prisma.nvflareJob.updateMany({ where: { id: job.id, status: "RUNNING" }, data: { status: "FAILED", completedAt: new Date(), commandSummary: reason } });
    if (moved.count === 0) return { view, aborted: false }; // the run moved on first (completed, aborted by a manager): do not claim FAILED
    {
      await prisma.nvflareJobEvent.create({
        data: {
          jobId: job.id,
          studyId: job.studyId,
          eventType: "FAILED",
          message: reason,
          metadata: { kind: "site_lost_abort", sites: decision.abortFor.map((entry) => ({ code: entry.code, clientName: entry.clientName, reason: entry.reason, since: entry.since })), timeoutMs } as Prisma.InputJsonObject
        }
      });
    }
    return { view, aborted: true };
  } catch {
    return none;
  }
}

/**
 * Moves an active published-runtime job to the status NVFLARE reports and, at the transition to a terminal status,
 * captures the round metrics and the server log. Also back-fills both for a terminal job that lacks them while the
 * aggregator still holds them (older runs, runs nobody watched). For a RUNNING job it also looks for lost sites (see
 * evaluateSiteLoss). Returns the status now on record.
 */
export async function reconcileRun(job: ReconcilableJob): Promise<{ status: string; metricsCaptured: boolean; logCaptured: boolean; siteLost: SiteLostView | null }> {
  let status = job.status;
  let logCapturedAtTransition = false;
  if (job.deployment?.runtimeMode === "k8s" && job.nvflareJobId && ACTIVE.has(job.status)) {
    try {
      const meta = await adapterJobMeta({ studyId: job.studyId, adapterUrl: job.deployment.adapterUrl }, job.nvflareJobId);
      const next = fedlifyJobStatus(meta.status);
      if (next !== job.status) {
        // Terminal: the log is read before the status moves, so a cleanup that follows the transition cannot lose it.
        if (TERMINAL.has(next)) logCapturedAtTransition = await captureRunLog(job);
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
  let siteLost: SiteLostView | null = null;
  let abortedForSiteLoss = false;
  if (status === "RUNNING") {
    const loss = await evaluateSiteLoss({ ...job, status });
    siteLost = loss.view;
    if (loss.aborted) {
      status = "FAILED";
      abortedForSiteLoss = true; // the abort path already captured the log and metrics, before the aggregator aborted
    }
  }
  const terminal = TERMINAL.has(status) && !abortedForSiteLoss;
  const metricsCaptured = terminal ? await captureRunMetrics(job) : false;
  const logCaptured = terminal ? logCapturedAtTransition || (await captureRunLog(job)) : false;
  return { status, metricsCaptured, logCaptured, siteLost };
}

/**
 * Reconciles every active published-runtime run. Called by the run sweeper (POST /api/webhooks/run-sweep, once a
 * minute) so a dead site is noticed and a finished run's evidence is captured even when nobody has the page open.
 */
export async function sweepRuns(limit = 50): Promise<{ checked: number; moved: number; abortedForSiteLoss: number; warned: number }> {
  const jobs = await prisma.nvflareJob.findMany({
    where: { status: { in: ["SUBMITTED", "SCHEDULED", "RUNNING"] }, nvflareJobId: { not: null }, deployment: { is: { runtimeMode: "k8s" } } },
    include: { deployment: { select: { runtimeMode: true, adapterUrl: true } } },
    orderBy: { updatedAt: "asc" },
    take: limit
  });
  const result = { checked: jobs.length, moved: 0, abortedForSiteLoss: 0, warned: 0 };
  const outcomes = await Promise.all(jobs.map(async (job) => ({ job, outcome: await reconcileRun(job).catch(() => null) })));
  for (const { job, outcome } of outcomes) {
    if (!outcome) continue;
    if (outcome.status !== job.status) {
      result.moved += 1;
      if (outcome.status === "FAILED" && job.status === "RUNNING" && outcome.siteLost) result.abortedForSiteLoss += 1;
    } else if (outcome.siteLost) result.warned += 1;
  }
  return result;
}
