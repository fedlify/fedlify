import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ inFlightQueries: 0, systemInfo: vi.fn(), watchdog: vi.fn() }));

vi.mock("@/lib/workflow-watchdog", () => ({ checkPublishRun: (...a: unknown[]) => h.watchdog(...a) }));
vi.mock("@/lib/study-runtime", () => ({
  ADAPTER_STATUS_TIMEOUT_MS: 5000,
  adapterSystemInfo: (...a: unknown[]) => h.systemInfo(...a),
  nvflareClientName: ({ code }: { code: string }) => `site-${code}`,
  StudyRuntimeError: class extends Error {}
}));
vi.mock("@/lib/prisma", () => {
  const version = (id: string) => ({ id, projectId: "p1", version: id, gitTag: id, gitCommit: `c-${id}`, imageDigest: null, validationStatus: "PASSED", publishedAt: null, ciRuns: [] });
  return {
    prisma: {
      cIValidationRun: {
        findMany: async () => {
          h.inFlightQueries += 1;
          return [{ id: "ci1", pipelineVersionId: "v9", workflowId: "w1" }];
        }
      },
      nvflareDeployment: { findFirst: async () => ({ id: "d1", status: "ACTIVE", active: true, adapterUrl: "http://a", pipelineVersionId: "v1", imageDigest: null, provisionedSites: [] }) },
      studySite: { findMany: async () => [] },
      pipelineProject: { findMany: async () => [{ id: "p1", name: "P", versions: [version("v12"), version("v11")] }] },
      pipelineVersion: { findUnique: async ({ where }: { where: { id: string } }) => version(where.id) },
      agentProposal: { findMany: async () => [] },
      nvflareJob: { findMany: async () => [] }
    }
  };
});

import { loadAggregatorOverview } from "@/lib/aggregator-overview";

beforeEach(() => {
  h.inFlightQueries = 0;
  h.systemInfo.mockReset().mockResolvedValue({ clients: [] });
  h.watchdog.mockReset().mockResolvedValue(null);
});

describe("loadAggregatorOverview", () => {
  it("lists the version the study server serves even when newer versions push it out of the window", async () => {
    const overview = await loadAggregatorOverview("s1");
    expect(overview.projects[0].versions.map((v) => v.id)).toContain("v1");
  });

  it("asks the study server with a short timeout, not the long job timeout", async () => {
    await loadAggregatorOverview("s1");
    expect(h.systemInfo).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 5000 });
  });

  it("runs the publish watchdog by default and skips it for read-only callers", async () => {
    await loadAggregatorOverview("s1");
    expect(h.inFlightQueries).toBe(1);
    expect(h.watchdog).toHaveBeenCalled();
    h.inFlightQueries = 0;
    h.watchdog.mockClear();
    await loadAggregatorOverview("s1", { watchdog: false });
    expect(h.inFlightQueries).toBe(0);
    expect(h.watchdog).not.toHaveBeenCalled();
  });
});
