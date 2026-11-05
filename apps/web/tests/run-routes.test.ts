import { beforeEach, describe, expect, it, vi } from "vitest";

const caps = new Set<string>();
const jobFind = vi.fn();
const versionFind = vi.fn();
const siteFind = vi.fn();
const listTree = vi.fn();
const readFile = vi.fn();
const readObject = vi.fn();
const updateMany = vi.fn();
const eventCreate = vi.fn();
const liveMeta = vi.fn();
const liveMetrics = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({
  canAccessStudy: async (_u: string, _s: string, action: string) => caps.has(action),
  assertStudyAccess: async (_u: string, _s: string, action: string) => {
    if (!caps.has(action)) throw Object.assign(new Error("no"), { name: "ForbiddenError" });
  },
  isForbiddenError: (e: unknown) => e instanceof Error && e.name === "ForbiddenError"
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    nvflareJob: { findFirst: (...a: unknown[]) => jobFind(...a), findMany: async () => [], updateMany: (...a: unknown[]) => updateMany(...a) },
    nvflareJobEvent: { findMany: async () => [], create: (...a: unknown[]) => eventCreate(...a) },
    pipelineVersion: { findFirst: (...a: unknown[]) => versionFind(...a) },
    studySite: { findMany: (...a: unknown[]) => siteFind(...a) }
  }
}));
vi.mock("@/lib/gitea", () => ({
  GiteaApiError: class extends Error {},
  giteaCommitUrl: (r: string, s: string) => `${r}/commit/${s}`,
  listGiteaTreePaths: (...a: unknown[]) => listTree(...a),
  readGiteaFileAtRef: (...a: unknown[]) => readFile(...a)
}));
vi.mock("@/lib/storage", () => ({ readObject: (...a: unknown[]) => readObject(...a) }));
vi.mock("@/lib/study-runtime", () => ({
  adapterJobMetrics: (...a: unknown[]) => liveMetrics(...a),
  adapterJobMeta: (...a: unknown[]) => liveMeta(...a),
  fedlifyJobStatus: (s: string) => (s === "FINISHED:COMPLETED" ? "COMPLETED" : s.startsWith("FINISHED") ? "FAILED" : "RUNNING")
}));

import { GET as getCode } from "@/app/api/v1/studies/[studyId]/runs/[jobId]/code/route";
import { GET as getDetail } from "@/app/api/v1/studies/[studyId]/runs/[jobId]/route";
import { GET as getLogs } from "@/app/api/v1/studies/[studyId]/runs/[jobId]/logs/route";
import { sha256 } from "@/lib/crypto";
import { clearTreeCache } from "@/lib/gitea-tree-cache";

const call = <A extends unknown[]>(fn: (...a: A) => Promise<Response | undefined>) => async (...a: A) => (await fn(...a))!;
const detailRoute = call(getDetail as never);
const logsRoute = call(getLogs as never);
const codeRoute = call(getCode as never);

const params = { params: Promise.resolve({ studyId: "s1", jobId: "j1" }) };
const req = (q = "") => ({ nextUrl: new URL(`https://app.test/x${q}`) }) as never;
const COMMIT = "abcdef1234567890";
const PARENT = "1111111222222233";
const metricsText = [
  JSON.stringify({ event: "contribution", round: 0, site: "site-a", numSamples: 10, metrics: { auroc: 0.6 } }),
  JSON.stringify({ event: "contribution", round: 0, site: "site-b", numSamples: 10, metrics: { auroc: 0.9 } })
].join("\n");
const metricsBody = Buffer.from(metricsText);

const job = {
  id: "j1", studyId: "s1", status: "COMPLETED", nvflareJobId: "n1", gitCommit: COMMIT, imageDigest: "sha256:img", siteDigests: [{ site: "A" }], runParameters: { numRounds: 1, minClients: 2 },
  selectedSites: [{ code: "A", nvflareClientName: "site-a" }, { code: "B", nvflareClientName: "site-b" }],
  createdAt: new Date(), submittedAt: null, completedAt: null, pipelineVersionId: "pv", metricsSummary: null,
  submittedBy: { name: "Ada" }, deployment: { runtimeMode: "k8s", adapterUrl: "http://x", hostname: "h" },
  pipelineVersion: { version: "v2", createdAt: new Date(), gitCommit: "ffffffffff", approvalStatus: "APPROVED", validationStatus: "PASSED", project: { id: "p1", name: "P", giteaOwner: "o", giteaRepo: "r", giteaRepoUrl: "https://git/o/r" } },
  result: { id: "res", artifacts: [{ kind: "ROUND_METRICS", storageKey: "k", checksum: sha256(metricsBody) }, { kind: "LOG", storageKey: "log", checksum: sha256(Buffer.from("hi token=abc123")), filename: "log.txt", sizeBytes: 5n }], modelRelease: null }
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTreeCache();
  liveMetrics.mockResolvedValue({ source: "aggregator", records: [] });
  updateMany.mockResolvedValue({ count: 1 });
  caps.clear();
  jobFind.mockResolvedValue(job);
  versionFind.mockResolvedValue({ version: "v1", gitCommit: PARENT });
  siteFind.mockResolvedValue([]);
  readObject.mockImplementation(async (k: string) => (k === "k" ? metricsBody : Buffer.from("hi token=abc123")));
  listTree.mockImplementation(async ({ ref }: { ref: string }) => ({ truncated: false, files: ref === COMMIT ? [{ path: "client.py", sha: "2" }, { path: "new.py", sha: "9" }] : [{ path: "client.py", sha: "1" }, { path: "gone.py", sha: "3" }] }));
  readFile.mockImplementation(async ({ ref }: { ref: string }) => (ref === COMMIT ? "a\nb2\n" : "a\nb\n"));
});

describe("run detail route", () => {
  it("denies without study read access and loads nothing", async () => {
    const res = await detailRoute(req(), params);
    expect(res.status).toBe(403);
    expect(jobFind).not.toHaveBeenCalled();
  });

  it("gives managers stored metrics and flags, including logs", async () => {
    ["read", "manage", "audit"].forEach((c) => caps.add(c));
    const body = await (await detailRoute(req(), params)).json();
    expect(body.metrics.status).toBe("stored");
    expect(body.metrics.rounds[0].average.auroc).toBeCloseTo(0.75, 10);
    expect(body.run.snapshot).toMatchObject({ gitCommit: COMMIT, imageDigest: "sha256:img" });
    expect(body.can).toMatchObject({ logs: true, audit: true });
  });

  it("limits a site operator to their own site and hides the 2-site average, logs and audit", async () => {
    caps.add("read");
    siteFind.mockResolvedValue([{ code: "A" }]);
    const body = await (await detailRoute(req(), params)).json();
    expect(body.scope).toBe("site");
    expect(body.can).toMatchObject({ logs: false, audit: false, modelCard: false });
    expect(JSON.stringify(body)).not.toContain("site-b");
    expect(JSON.stringify(body.metrics)).not.toContain("0.9");
    expect(body.metrics.rounds[0].average).toEqual({});
    expect(body.run.snapshot.siteDigests).toBeNull();
    expect(body.events).toEqual([]);
  });

  it("refuses a site operator whose site is not in the run", async () => {
    caps.add("read");
    siteFind.mockResolvedValue([{ code: "Z" }]);
    expect((await detailRoute(req(), params)).status).toBe(403);
  });

  it("reports missing metrics as missing for an older run", async () => {
    caps.add("read"); caps.add("manage");
    jobFind.mockResolvedValue({ ...job, gitCommit: null, imageDigest: null, siteDigests: null, runParameters: null, result: null, status: "FAILED" });
    const body = await (await detailRoute(req(), params)).json();
    expect(body.metrics.status).toBe("missing");
    expect(body.metrics.rounds).toBeUndefined();
    expect(body.run.snapshot.recorded).toBe(false);
  });

  it("does not show a stored metrics file whose checksum no longer matches", async () => {
    caps.add("read"); caps.add("manage");
    readObject.mockResolvedValue(Buffer.from("tampered"));
    const body = await (await detailRoute(req(), params)).json();
    expect(body.metrics.status).toBe("unavailable");
    expect(body.metrics.rounds).toBeUndefined();
  });

  it("looks the job up within the study", async () => {
    caps.add("read"); caps.add("manage");
    await detailRoute(req(), params);
    expect(jobFind.mock.calls[0][0].where).toEqual({ id: "j1", studyId: "s1" });
  });
});

describe("run logs route", () => {
  it("is manager only: site roles and readers get 403 before any lookup", async () => {
    caps.add("read"); caps.add("viewLogs"); caps.add("audit");
    const res = (await logsRoute(req(), params))!;
    expect(res.status).toBe(403);
    expect(jobFind).not.toHaveBeenCalled();
  });
  it("masks secret-looking text for managers", async () => {
    caps.add("manage");
    jobFind.mockResolvedValue({ ...job, result: { artifacts: [job.result.artifacts[1]] } });
    const body = await (await logsRoute(req(), params)).json();
    expect(body.text).toContain("[redacted]");
    expect(body.text).not.toContain("abc123");
  });
});

describe("run code route", () => {
  beforeEach(() => caps.add("read"));
  it.each(["../../etc/passwd", "/etc/passwd", "a/../b", "%2e%2e/x", ".git/config"])("rejects traversal path %s before contacting Gitea", async (p) => {
    caps.add("manage");
    const res = (await codeRoute(req(`?path=${encodeURIComponent(p)}`), params))!;
    expect(res.status).toBe(400);
    expect(readFile).not.toHaveBeenCalled();
  });
  it("404s a safe path that is not in the commit's tree", async () => {
    caps.add("manage");
    expect((await codeRoute(req("?path=secrets.txt"), params)).status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
  it("uses the run's own commit, ignoring any ref in the query, and marks changes against the parent", async () => {
    caps.add("manage");
    const body = await (await codeRoute(req(`?path=client.py&ref=main&commit=deadbeef`), params)).json();
    expect(listTree.mock.calls[0][0].ref).toBe(COMMIT);
    expect(readFile.mock.calls[0][0].ref).toBe(COMMIT);
    expect(body.commit).toBe(COMMIT);
    expect(body.files).toEqual([{ path: "client.py", status: "modified" }, { path: "new.py", status: "added" }]);
    expect(body.deletedPaths).toEqual(["gone.py"]);
    expect(body.file.diff.added).toBe(1);
    expect(body.commitUrl).toBe(`https://git/o/r/commit/${COMMIT}`);
  });
  it("409s when no commit is recorded rather than guessing", async () => {
    caps.add("manage");
    jobFind.mockResolvedValue({ ...job, gitCommit: null, pipelineVersion: { ...job.pipelineVersion, gitCommit: null } });
    expect((await codeRoute(req(), params)).status).toBe(409);
  });
  it("denies without study access", async () => {
    caps.clear();
    expect((await codeRoute(req(), params)).status).toBe(403);
    expect(listTree).not.toHaveBeenCalled();
  });
});

describe("run detail evidence capture and reconciliation", () => {
  const records = [{ event: "contribution", round: 0, site: "site-a", numSamples: 10, metrics: { auroc: 0.7 } }];
  it("shows captured metrics for a FAILED run that was never saved", async () => {
    caps.add("read"); caps.add("manage");
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    jobFind.mockResolvedValue({ ...job, status: "FAILED", result: null, metricsJsonl: text, metricsChecksum: sha256(Buffer.from(text)) });
    const body = await (await detailRoute(req(), params)).json();
    expect(body.metrics.status).toBe("stored");
    expect(body.metrics.rounds[0].sites[0].metrics.auroc).toBe(0.7);
  });
  it("refuses captured metrics whose checksum does not match", async () => {
    caps.add("read"); caps.add("manage");
    jobFind.mockResolvedValue({ ...job, status: "FAILED", result: null, metricsJsonl: "{}", metricsChecksum: "bad" });
    expect((await (await detailRoute(req(), params)).json()).metrics.status).toBe("unavailable");
  });
  it("moves a RUNNING job to COMPLETED when NVFLARE says so and captures its metrics", async () => {
    caps.add("read"); caps.add("manage");
    const running = { ...job, status: "RUNNING", result: null, metricsJsonl: null, metricsChecksum: null };
    const done = { ...running, status: "COMPLETED", metricsJsonl: "x" };
    jobFind.mockResolvedValueOnce(running).mockResolvedValue(done);
    liveMeta.mockResolvedValue({ status: "FINISHED:COMPLETED", meta: {} });
    liveMetrics.mockResolvedValue({ source: "aggregator", records });
    const body = await (await detailRoute(req(), params)).json();
    const statusUpdate = updateMany.mock.calls.find((c) => c[0].data.status);
    expect(statusUpdate?.[0]).toMatchObject({ where: { id: "j1", status: "RUNNING" }, data: { status: "COMPLETED" } });
    const capture = updateMany.mock.calls.find((c) => c[0].data.metricsJsonl);
    expect(capture?.[0].where).toEqual({ id: "j1", metricsJsonl: null });
    expect(capture?.[0].data.metricsChecksum).toBe(sha256(Buffer.from(capture?.[0].data.metricsJsonl)));
    expect(eventCreate).toHaveBeenCalled();
    expect(body.run.status).toBe("COMPLETED");
  });
  it("does not touch the aggregator for a completed run that already has metrics", async () => {
    caps.add("read"); caps.add("manage");
    jobFind.mockResolvedValue({ ...job, metricsJsonl: metricsText });
    await detailRoute(req(), params);
    expect(liveMeta).not.toHaveBeenCalled();
    expect(liveMetrics).not.toHaveBeenCalled();
  });
  it("keeps the recorded status when the aggregator is unreachable", async () => {
    caps.add("read"); caps.add("manage");
    jobFind.mockResolvedValue({ ...job, status: "RUNNING", result: null });
    liveMeta.mockRejectedValue(new Error("down"));
    expect((await (await detailRoute(req(), params)).json()).run.status).toBe("RUNNING");
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("run code route tree cache", () => {
  it("reads each commit tree once across file clicks", async () => {
    caps.add("read"); caps.add("manage");
    await codeRoute(req("?path=client.py"), params);
    await codeRoute(req("?path=new.py"), params);
    expect(listTree).toHaveBeenCalledTimes(2); // current + parent, once
  });
  it("still checks access before using a cached tree", async () => {
    caps.add("read"); caps.add("manage");
    await codeRoute(req(), params);
    caps.clear();
    expect((await codeRoute(req(), params)).status).toBe(403);
  });
});
