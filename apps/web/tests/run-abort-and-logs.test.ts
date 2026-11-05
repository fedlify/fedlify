import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const caps = new Set<string>();
const jobFind = vi.fn();
const jobFindFirst = vi.fn();
const updateMany = vi.fn();
const abortJob = vi.fn();
const jobLog = vi.fn();
const sweep = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({
  assertStudyAccess: async (_u: string, _s: string, action: string) => {
    if (!caps.has(action)) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    nvflareJob: { findUnique: (...a: unknown[]) => jobFind(...a), findFirst: (...a: unknown[]) => jobFindFirst(...a), updateMany: (...a: unknown[]) => (calls.push("capture-write"), updateMany(...a)) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ nvflareJob: { update: async () => ({ id: "j1" }) }, nvflareJobEvent: { create: async () => ({}) } })
  }
}));
vi.mock("@/lib/storage", () => ({ readObject: async () => Buffer.from("") }));
vi.mock("@/lib/study-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/study-runtime")>()),
  adapterJobLog: (...a: unknown[]) => (calls.push("log"), jobLog(...a)),
  adapterJobMetrics: async () => (calls.push("metrics"), { source: "live", records: [] }),
  adapterAbortJob: (...a: unknown[]) => (calls.push("abort"), abortJob(...a))
}));
vi.mock("@/lib/run-reconcile", () => ({ sweepRuns: (...a: unknown[]) => sweep(...a) }));

import { POST as abortRoute } from "@/app/api/v1/nvflare/jobs/[jobId]/abort/route";
import { GET as logsRoute } from "@/app/api/v1/studies/[studyId]/runs/[jobId]/logs/route";
import { POST as sweepRoute } from "@/app/api/webhooks/run-sweep/route";
import { sha256 } from "@/lib/crypto";

const job = { id: "j1", studyId: "s1", status: "RUNNING", nvflareJobId: "n1", study: { orgId: "o" }, metricsJsonl: null, logChecksum: null, deployment: { runtimeMode: "k8s", adapterUrl: "http://agg", hostname: "x.fedlify.com" } };
const abortReq = () => abortRoute(new Request("http://x/api", { method: "POST", body: JSON.stringify({ reason: "stop" }) }) as never, { params: Promise.resolve({ jobId: "j1" }) }) as Promise<Response>;
const logsReq = () => logsRoute({} as never, { params: Promise.resolve({ studyId: "s1", jobId: "j1" }) }) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  caps.clear();
  jobFind.mockResolvedValue(job);
  updateMany.mockResolvedValue({ count: 1 });
  jobLog.mockResolvedValue("log before abort token=supersecretvalue");
});

describe("abort route", () => {
  it("captures the server log and metrics BEFORE asking the aggregator to abort", async () => {
    caps.add("abortJob");
    const response = await abortReq();
    expect(response.status).toBe(200);
    expect(calls.indexOf("log")).toBeLessThan(calls.indexOf("abort"));
    expect(calls.indexOf("metrics")).toBeLessThan(calls.indexOf("abort"));
    const write = updateMany.mock.calls.find((c) => c[0].data.logText !== undefined);
    expect(write?.[0].data.logText).not.toContain("supersecretvalue");
  });
  it("still aborts when the log cannot be captured (capture is best effort)", async () => {
    caps.add("abortJob");
    jobLog.mockRejectedValue(new Error("gone"));
    expect((await abortReq()).status).toBe(200);
    expect(abortJob).toHaveBeenCalled();
  });
  it("answers 502 and records nothing when the aggregator refuses the abort", async () => {
    caps.add("abortJob");
    abortJob.mockRejectedValue(new (await import("@/lib/study-runtime")).StudyRuntimeError("down"));
    expect((await abortReq()).status).toBe(502);
    // the mid-run snapshot taken before the failed abort is discarded, so the real log can be captured later
    expect(updateMany.mock.calls.some((c) => c[0].data.logText === null && c[0].where.logCapturedAt?.gte instanceof Date)).toBe(true);
  });
});

describe("logs route for runs without a saved result", () => {
  const captured = "captured server log";
  it("is manager only", async () => {
    caps.add("read");
    expect((await logsReq()).status).toBe(403);
    expect(jobFindFirst).not.toHaveBeenCalled();
  });
  it("serves the captured log of a FAILED, unsaved run", async () => {
    caps.add("manage");
    jobFindFirst.mockResolvedValue({ id: "j1", status: "FAILED", result: null, logText: captured, logChecksum: sha256(Buffer.from(captured)), logTruncated: false, logCapturedAt: new Date() });
    const body = await (await logsReq()).json();
    expect(body).toMatchObject({ available: true, source: "captured", text: captured, truncated: false });
  });
  it("reads the log columns from the database: a row projected by the route's own select still serves the log", async () => {
    caps.add("manage");
    const full = { id: "j1", status: "FAILED", result: null, logText: captured, logChecksum: sha256(Buffer.from(captured)), logTruncated: false, logCapturedAt: new Date(), metricsJsonl: "not selected" };
    jobFindFirst.mockImplementation(async (arg: { select: Record<string, unknown> }) => Object.fromEntries(Object.entries(full).filter(([key]) => key in arg.select)));
    const body = await (await logsReq()).json();
    expect(body).toMatchObject({ available: true, source: "captured", text: captured });
  });
  it("masks secrets again on the way out", async () => {
    caps.add("manage");
    const text = "password=hunter2hunter2";
    jobFindFirst.mockResolvedValue({ id: "j1", status: "ABORTED", result: null, logText: text, logChecksum: sha256(Buffer.from(text)), logTruncated: false, logCapturedAt: null });
    expect((await (await logsReq()).json()).text).not.toContain("hunter2");
  });
  it("refuses a captured log whose checksum does not match", async () => {
    caps.add("manage");
    jobFindFirst.mockResolvedValue({ id: "j1", status: "FAILED", result: null, logText: "tampered", logChecksum: "bad", logTruncated: false, logCapturedAt: null });
    const body = await (await logsReq()).json();
    expect(body.available).toBe(false);
    expect(body.text).toBeNull();
  });
  it("explains a run with no captured log instead of claiming it was never saved", async () => {
    caps.add("manage");
    jobFindFirst.mockResolvedValue({ id: "j1", status: "FAILED", result: null, logText: null, logChecksum: null, logTruncated: null, logCapturedAt: null });
    const body = await (await logsReq()).json();
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/No log was captured/);
  });
});

describe("run sweep webhook", () => {
  const SECRET = "run-sweep-secret";
  const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const call = (headers: Record<string, string> = {}) => sweepRoute(new Request("http://x/api", { method: "POST", body: "{}", headers }) as never) as Promise<Response>;
  beforeEach(() => {
    process.env.ARGO_WEBHOOK_SECRET = SECRET;
    sweep.mockResolvedValue({ checked: 2, moved: 0, abortedForSiteLoss: 0, warned: 1 });
  });
  it("refuses unsigned, wrongly signed and unconfigured calls without sweeping", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ "x-fedlify-signature": sign("{}", "other") })).status).toBe(401);
    delete process.env.ARGO_WEBHOOK_SECRET;
    expect((await call({ "x-fedlify-signature": sign("{}") })).status).toBe(503);
    expect(sweep).not.toHaveBeenCalled();
  });
  it("sweeps for a signed call and returns counts only", async () => {
    const response = await call({ "x-fedlify-signature": sign("{}") });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { checked: 2, moved: 0, abortedForSiteLoss: 0, warned: 1 } });
  });
});
