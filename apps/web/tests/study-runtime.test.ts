import { afterEach, describe, expect, it } from "vitest";
import {
  fedlifyJobStatus,
  nvflareClientName,
  studyAdapterToken,
  studyAdapterUrl,
  studyHostname,
  studyNamespace,
  studyRuntimeSlug,
  summarizeRoundMetrics
} from "@/lib/study-runtime";

describe("study runtime", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("derives a DNS-safe hostname, namespace, and adapter URL per study", () => {
    const slug = studyRuntimeSlug("Heart Failure Mortality — eICU (2026)!");
    expect(slug).toBe("heart-failure-mortality-eicu-2026");
    expect(studyHostname(slug)).toBe("heart-failure-mortality-eicu-2026.fedlify.com");
    expect(studyNamespace(slug)).toBe("study-heart-failure-mortality-eicu-2026");
    expect(studyAdapterUrl(slug)).toBe("http://aggregator.study-heart-failure-mortality-eicu-2026.svc.cluster.local:3010");

    const long = studyRuntimeSlug("a".repeat(80), "x1y2z3");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-x1y2z3")).toBe(true);
  });

  it("matches the publish workflow's adapter token (Python HMAC test vector)", () => {
    process.env.FEDLIFY_ADAPTER_SIGNING_SECRET = "test-signing-secret";
    expect(studyAdapterToken("study-123")).toBe("127257b3f81838188d7fdb01966232e36165a2126eed467901747db06c82ede2");
  });

  it("refuses to derive adapter tokens without a signing secret", () => {
    delete process.env.FEDLIFY_ADAPTER_SIGNING_SECRET;
    expect(() => studyAdapterToken("study-123")).toThrow("FEDLIFY_ADAPTER_SIGNING_SECRET");
  });

  it("normalizes NVFLARE client names the same way publish and join kits do", () => {
    expect(nvflareClientName({ code: "73", nvflareClientName: "hospital-73.toronto" })).toBe("hospital-73_toronto");
    expect(nvflareClientName({ code: "b", nvflareClientName: null })).toBe("site_b");
  });

  it("maps NVFLARE job states", () => {
    expect(fedlifyJobStatus("FINISHED:COMPLETED")).toBe("COMPLETED");
    expect(fedlifyJobStatus("FINISHED:EXECUTION_EXCEPTION")).toBe("FAILED");
    expect(fedlifyJobStatus("FINISHED:ABORTED")).toBe("ABORTED");
    expect(fedlifyJobStatus("RUNNING")).toBe("RUNNING");
    expect(fedlifyJobStatus("DISPATCHED")).toBe("SUBMITTED");
  });

  it("summarizes per-site contributions into sample-weighted round metrics", () => {
    const rounds = summarizeRoundMetrics([
      { ts: 1, event: "contribution", round: 1, site: "site_a", numSamples: 300, metrics: { auroc: 0.9, accuracy: 0.8 } },
      { ts: 2, event: "contribution", round: 1, site: "site_b", numSamples: 100, metrics: { auroc: 0.7, accuracy: 0.6 } },
      { ts: 3, event: "round_done", round: 1 },
      { ts: 4, event: "contribution", round: 0, site: "site_a", numSamples: 300, metrics: { auroc: 0.5 } }
    ]);
    expect(rounds.map((row) => row.round)).toEqual([0, 1]);
    expect(rounds[1].sites).toHaveLength(2);
    expect(rounds[1].weighted.auroc).toBeCloseTo(0.85);
    expect(rounds[1].weighted.accuracy).toBeCloseTo(0.75);
  });
});
