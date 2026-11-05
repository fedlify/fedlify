import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const updateMany = vi.fn();
const eventCreate = vi.fn();
const jobFindMany = vi.fn();
const siteFindMany = vi.fn();
const meta = vi.fn();
const systemInfo = vi.fn();
const jobLog = vi.fn();
const jobMetrics = vi.fn();
const abortJob = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    nvflareJob: { updateMany: (...a: unknown[]) => updateMany(...a), findMany: (...a: unknown[]) => jobFindMany(...a) },
    nvflareJobEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    site: { findMany: (...a: unknown[]) => siteFindMany(...a) }
  }
}));
vi.mock("@/lib/study-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/study-runtime")>()),
  adapterJobMeta: (...a: unknown[]) => meta(...a),
  adapterSystemInfo: (...a: unknown[]) => systemInfo(...a),
  adapterJobLog: (...a: unknown[]) => (calls.push("log"), jobLog(...a)),
  adapterJobMetrics: (...a: unknown[]) => (calls.push("metrics"), jobMetrics(...a)),
  adapterAbortJob: (...a: unknown[]) => (calls.push("abort"), abortJob(...a)),
  adapterJobResultZip: async () => {
    throw new Error("no zip");
  }
}));

import { sha256 } from "@/lib/crypto";
import { LOG_MAX_BYTES } from "@/lib/log-redact";
import { captureRunLog } from "@/lib/run-capture";
import { reconcileRun, sweepRuns } from "@/lib/run-reconcile";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const MIN = 60_000;
const deployment = { runtimeMode: "k8s", adapterUrl: "http://agg", hostname: "x.fedlify.com" };
const selectedSites = [
  { code: "A", siteId: "sa", nvflareClientName: "site-A" },
  { code: "B", siteId: "sb", nvflareClientName: "site-B" }
];
const baseJob = { id: "j1", studyId: "s1", status: "RUNNING", nvflareJobId: "n1", deployment, selectedSites, metricsJsonl: null, logChecksum: null, siteLostSince: null, siteLostSeenAt: null, siteLostSites: null };
const beats = (aStatus: string, aAgeMs: number) => [
  { id: "sa", heartbeats: [{ createdAt: new Date(Date.now() - aAgeMs), status: aStatus }] },
  { id: "sb", heartbeats: [{ createdAt: new Date(Date.now() - 5_000), status: "CONNECTED" }] }
];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  updateMany.mockResolvedValue({ count: 1 });
  meta.mockResolvedValue({ status: "RUNNING", meta: {} });
  systemInfo.mockResolvedValue({ clients: [{ name: "site-A" }, { name: "site-B" }] });
  siteFindMany.mockResolvedValue(beats("CONNECTED", 5_000));
  jobLog.mockResolvedValue("server log line\n");
  jobMetrics.mockResolvedValue({ source: "live", records: [] });
  abortJob.mockResolvedValue(undefined);
  delete process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS;
});

describe("site lost during a RUNNING run", () => {
  it("warns on the first sighting (episode stored, event written) and does NOT abort", async () => {
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    const result = await reconcileRun(baseJob);
    expect(result.status).toBe("RUNNING");
    expect(result.siteLost?.sites.map((s) => s.clientName)).toEqual(["site-A"]);
    expect(result.siteLost?.sites[0].abortAt).not.toBeNull();
    expect(abortJob).not.toHaveBeenCalled();
    const stored = updateMany.mock.calls.find((c) => c[0].data.siteLostSites);
    expect(stored?.[0].where).toEqual({ id: "j1", status: "RUNNING" });
    const event = eventCreate.mock.calls.find((c) => c[0].data.metadata?.kind === "site_lost_warning");
    expect(event?.[0].data).toMatchObject({ jobId: "j1", eventType: "SITE_UPDATE" });
    expect(event?.[0].data.message).toContain("site-A");
  });

  it("does nothing, and never marks failed, when the aggregator cannot be read", async () => {
    systemInfo.mockRejectedValue(new Error("adapter timeout"));
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    const old = { ...baseJob, siteLostSince: new Date(NOW - 30 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 30 * MIN).toISOString() }] };
    const result = await reconcileRun(old);
    expect(result.status).toBe("RUNNING");
    expect(abortJob).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("does not abort a run whose stored episode is old but was not observed since (gap rule)", async () => {
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    const stale = { ...baseJob, siteLostSince: new Date(Date.now() - 60 * MIN), siteLostSeenAt: new Date(Date.now() - 45 * MIN), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 60 * MIN).toISOString() }] };
    const result = await reconcileRun(stale);
    expect(result.status).toBe("RUNNING");
    expect(abortJob).not.toHaveBeenCalled();
  });

  it("after the timeout: captures the log and metrics FIRST, aborts through the shared path, ends FAILED naming the lost site", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    jobMetrics.mockResolvedValue({ source: "live", records: [{ ts: 1, event: "round_done", round: 1 }] });
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 5 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "its runner reported OFFLINE", since: new Date(Date.now() - 5 * MIN).toISOString() }] };
    const result = await reconcileRun(episode);
    expect(result.status).toBe("FAILED");
    expect(calls.indexOf("log")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("log")).toBeLessThan(calls.indexOf("abort"));
    expect(calls.indexOf("metrics")).toBeLessThan(calls.indexOf("abort"));
    expect(abortJob).toHaveBeenCalledWith({ studyId: "s1", adapterUrl: "http://agg" }, "n1");
    const failed = updateMany.mock.calls.find((c) => c[0].data.status === "FAILED");
    expect(failed?.[0].where).toEqual({ id: "j1", status: "RUNNING" });
    expect(failed?.[0].data.commandSummary).toContain("site-A");
    expect(failed?.[0].data.completedAt).toBeInstanceOf(Date);
    const event = eventCreate.mock.calls.find((c) => c[0].data.eventType === "FAILED");
    expect(event?.[0].data.message).toContain("site-A");
    expect(event?.[0].data.metadata.kind).toBe("site_lost_abort");
  });

  it("keeps the run RUNNING when the abort itself fails (retry on the next evaluation)", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    abortJob.mockRejectedValue(new Error("adapter down"));
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 5 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 5 * MIN).toISOString() }] };
    const result = await reconcileRun(episode);
    expect(result.status).toBe("RUNNING");
    expect(updateMany.mock.calls.find((c) => c[0].data.status === "FAILED")).toBeUndefined();
  });

  it("a failed abort discards the pre-abort snapshot so the terminal transition can capture the real log", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    jobMetrics.mockResolvedValue({ source: "live", records: [{ round: 1, site: "site-A", metrics: { loss: 1 } }] });
    abortJob.mockRejectedValue(new Error("adapter down"));
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 5 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 5 * MIN).toISOString() }] };
    await reconcileRun(episode);
    const clearLog = updateMany.mock.calls.find((c) => c[0].data.logText === null && c[0].where.logCapturedAt?.gte instanceof Date);
    const clearMetrics = updateMany.mock.calls.find((c) => c[0].data.metricsJsonl === null && c[0].where.metricsCapturedAt?.gte instanceof Date);
    expect(clearLog).toBeDefined();
    expect(clearMetrics).toBeDefined();
    // the snapshot was written before the failed abort, and cleared after it
    expect(updateMany.mock.calls.indexOf(clearLog!)).toBeGreaterThan(updateMany.mock.calls.findIndex((c) => typeof c[0].data.logText === "string"));
  });

  it("does not claim FAILED when the guarded write finds the run already moved on", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    updateMany.mockImplementation(async (arg: { data: { status?: string } }) => ({ count: arg.data.status === "FAILED" ? 0 : 1 }));
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 5 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 5 * MIN).toISOString() }] };
    const result = await reconcileRun(episode);
    expect(result.status).toBe("RUNNING");
    expect(eventCreate.mock.calls.find((c) => c[0].data.metadata?.kind === "site_lost_abort")).toBeUndefined();
  });

  it("a heartbeat-silent site that the aggregator still lists warns but is never aborted", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("CONNECTED", 20 * MIN));
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 30 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "silent", reason: "r", since: new Date(Date.now() - 30 * MIN).toISOString() }] };
    const result = await reconcileRun(episode);
    expect(result.status).toBe("RUNNING");
    expect(result.siteLost?.sites[0]).toMatchObject({ state: "silent", abortAt: null });
    expect(abortJob).not.toHaveBeenCalled();
  });

  it("clears the episode and records recovery when the site returns", async () => {
    const episode = { ...baseJob, siteLostSince: new Date(Date.now() - 3 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 3 * MIN).toISOString() }] };
    const result = await reconcileRun(episode);
    expect(result.siteLost).toBeNull();
    expect(eventCreate.mock.calls.some((c) => c[0].data.metadata?.kind === "site_recovered")).toBe(true);
    expect(abortJob).not.toHaveBeenCalled();
  });

  it("does not look at sites for a run that is not RUNNING", async () => {
    meta.mockResolvedValue({ status: "FINISHED:COMPLETED", meta: {} });
    await reconcileRun(baseJob);
    expect(systemInfo).not.toHaveBeenCalled();
  });
});

describe("server log capture at run end", () => {
  it("captures the log of a run NVFLARE reports FAILED, before the status moves, with its checksum", async () => {
    meta.mockResolvedValue({ status: "FINISHED:EXECUTION_EXCEPTION", meta: {} });
    jobLog.mockResolvedValue("Traceback ...\nAuthorization: Bearer abcdefghijklmnop\n");
    const result = await reconcileRun(baseJob);
    expect(result.status).toBe("FAILED");
    expect(result.logCaptured).toBe(true);
    const capture = updateMany.mock.calls.find((c) => c[0].data.logText !== undefined);
    expect(capture?.[0].where).toEqual({ id: "j1", logChecksum: null });
    expect(capture?.[0].data.logText).toContain("Traceback");
    expect(capture?.[0].data.logText).not.toContain("abcdefghijklmnop");
    expect(capture?.[0].data.logChecksum).toBe(sha256(Buffer.from(capture?.[0].data.logText)));
    const order = updateMany.mock.calls.map((c) => (c[0].data.logText !== undefined ? "log" : c[0].data.status ? "status" : "other"));
    expect(order.indexOf("log")).toBeLessThan(order.indexOf("status"));
  });

  it("caps the size like the stored-result log and flags truncation", async () => {
    jobLog.mockResolvedValue("x".repeat(LOG_MAX_BYTES + 5000));
    await captureRunLog(baseJob);
    const data = updateMany.mock.calls[0][0].data;
    expect(Buffer.byteLength(data.logText)).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(data.logTruncated).toBe(true);
  });

  it("never overwrites a captured log and stores nothing when the aggregator has none", async () => {
    expect(await captureRunLog({ ...baseJob, logChecksum: "already" })).toBe(false);
    expect(jobLog).not.toHaveBeenCalled();
    jobLog.mockResolvedValue("   \n");
    expect(await captureRunLog(baseJob)).toBe(false);
    jobLog.mockRejectedValue(new Error("down"));
    expect(await captureRunLog(baseJob)).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("back-fills the log for a terminal run that has none, while the aggregator still holds it", async () => {
    const result = await reconcileRun({ ...baseJob, status: "ABORTED" });
    expect(result.logCaptured).toBe(true);
  });
});

describe("run sweep", () => {
  it("reconciles active published runs with nobody viewing and counts site-loss aborts", async () => {
    process.env.FEDLIFY_SITE_LOST_TIMEOUT_MS = String(2 * MIN);
    siteFindMany.mockResolvedValue(beats("OFFLINE", 5_000));
    jobFindMany.mockResolvedValue([{ ...baseJob, siteLostSince: new Date(Date.now() - 5 * MIN), siteLostSeenAt: new Date(Date.now() - 20_000), siteLostSites: [{ code: "A", clientName: "site-A", state: "down", reason: "r", since: new Date(Date.now() - 5 * MIN).toISOString() }] }]);
    const result = await sweepRuns();
    expect(result).toEqual({ checked: 1, moved: 1, abortedForSiteLoss: 1, warned: 0 });
    expect(jobFindMany.mock.calls[0][0].where.status).toEqual({ in: ["SUBMITTED", "SCHEDULED", "RUNNING"] });
  });
});
