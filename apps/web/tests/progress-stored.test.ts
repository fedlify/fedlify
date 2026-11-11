import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ job: null as unknown, adapterCalls: 0 }));
vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/rbac", () => ({ assertStudyAccess: async () => undefined, isForbiddenError: () => false }));
vi.mock("@/lib/prisma", () => ({ prisma: { nvflareJob: { findUnique: async () => h.job } } }));
vi.mock("@/lib/run-capture", () => ({ captureRunMetrics: async () => false, captureRunLog: async () => false }));
vi.mock("@/lib/study-runtime", async (orig) => {
  const real = await orig<typeof import("@/lib/study-runtime")>();
  return {
    ...real,
    adapterJobMeta: async () => { h.adapterCalls += 1; throw new real.StudyRuntimeError("The study server does not know this run.", 502); },
    adapterJobMetrics: async () => { h.adapterCalls += 1; throw new real.StudyRuntimeError("The study server does not know this run.", 502); }
  };
});

import { GET } from "@/app/api/v1/nvflare/jobs/[jobId]/progress/route";

const params = { params: Promise.resolve({ jobId: "j1" }) };
const line = (round: number, site: string, auroc: number) => JSON.stringify({ event: "contribution", round, site, numSamples: 10, metrics: { auroc } });

beforeEach(() => {
  h.adapterCalls = 0;
});

describe("run progress for a finished run", () => {
  it("answers from the kept metrics without asking the study server", async () => {
    h.job = { id: "j1", studyId: "s1", status: "FAILED", nvflareJobId: "n1", deployment: { runtimeMode: "k8s", adapterUrl: "http://a" }, metricsJsonl: [line(0, "site-a", 0.5), line(0, "site-b", 0.7), "not json"].join("\n") };
    const res = (await GET(new Request("http://x") as never, params)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metricsSource).toBe("stored");
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0].weighted.auroc).toBeCloseTo(0.6);
    expect(h.adapterCalls).toBe(0);
  });

  it("still asks the study server while a run is going", async () => {
    h.job = { id: "j1", studyId: "s1", status: "RUNNING", nvflareJobId: "n1", deployment: { runtimeMode: "k8s", adapterUrl: "http://a" }, metricsJsonl: null };
    const res = (await GET(new Request("http://x") as never, params)) as Response;
    expect(res.status).toBe(502);
    expect(h.adapterCalls).toBeGreaterThan(0);
  });
});
