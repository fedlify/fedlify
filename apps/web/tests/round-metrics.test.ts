import { describe, expect, it } from "vitest";
import { buildScale, buildSeries, DEFAULT_BOX, seriesPath } from "@/lib/chart-geometry";
import { buildModelCard, readPipelineDescriptor } from "@/lib/model-card";
import { diffLines } from "@/lib/line-diff";
import { isCommitSha, isSafeRepoPath } from "@/lib/repo-path";
import { parseRoundMetricsJsonl, scopeRoundMetrics, summarizeMetrics } from "@/lib/round-metrics";

const line = (o: object) => JSON.stringify(o);
const FILE = [
  line({ ts: 1, event: "contribution", round: 0, site: "site-a", numSamples: 100, metrics: { auroc: 0.6, loss: 0.9 } }),
  line({ ts: 2, event: "contribution", round: 0, site: "site-b", numSamples: 300, metrics: { auroc: 0.8 } }),
  line({ ts: 3, event: "round_done", round: 0 }),
  line({ ts: 4, event: "contribution", round: 1, site: "site-a", numSamples: 100, metrics: { auroc: 0.7 } }),
  "not json",
  line({ ts: 5, event: "contribution", round: 1, site: "site-b", numSamples: 300, metrics: { auroc: "NaN" } })
].join("\n");

describe("round metrics", () => {
  const parsed = parseRoundMetricsJsonl(FILE);

  it("weights by sample count over the sites that reported the metric", () => {
    expect(parsed.rounds[0].average.auroc).toBeCloseTo((0.6 * 100 + 0.8 * 300) / 400, 10);
    expect(parsed.rounds[0].weighting.auroc).toBe("samples");
  });

  it("never treats a missing metric as zero", () => {
    expect(parsed.rounds[0].average.loss).toBeCloseTo(0.9, 10); // only site-a reported loss
    expect(parsed.rounds[0].missing.loss).toEqual(["site-b"]);
    expect(parsed.rounds[1].average.auroc).toBeCloseTo(0.7, 10); // site-b's non-numeric value is dropped, not zeroed
    expect(parsed.rounds[1].missing.auroc).toEqual(["site-b"]);
    expect(parsed.droppedValues).toBe(1);
    expect(parsed.malformedLines).toBe(1);
  });

  it("falls back to an unweighted mean and says so when sample counts are absent", () => {
    const p = parseRoundMetricsJsonl([line({ event: "contribution", round: 0, site: "a", metrics: { auroc: 0.5 } }), line({ event: "contribution", round: 0, site: "b", numSamples: 10, metrics: { auroc: 0.9 } })].join("\n"));
    expect(p.rounds[0].average.auroc).toBeCloseTo(0.7, 10);
    expect(p.rounds[0].weighting.auroc).toBe("unweighted");
  });

  it("summarizes best and last round from stored values only", () => {
    const s = summarizeMetrics(parsed);
    expect(s.best).toEqual({ key: "auroc", value: (0.6 * 100 + 0.8 * 300) / 400, round: 0 });
    expect(s.last?.round).toBe(1);
    expect(summarizeMetrics(parseRoundMetricsJsonl("")).best).toBeNull();
  });

  it("hides other sites and small-cohort aggregates from a site operator", () => {
    const scoped = scopeRoundMetrics(parsed, new Set(["site-a"]));
    expect(scoped.rounds[0].sites.map((s) => s.site)).toEqual(["site-a"]);
    expect(scoped.rounds[0].average).toEqual({}); // two sites: the average would reveal site-b
    expect(scoped.aggregateHidden).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain("site-b");
  });
});

describe("chart geometry", () => {
  const parsed = parseRoundMetricsJsonl(FILE);
  it("plots stored values and leaves gaps instead of interpolating", () => {
    const series = buildSeries(parsed.rounds, "loss", parsed.sites);
    const siteB = series.find((s) => s.id === "site-b")!;
    expect(siteB.points.map((p) => p.y)).toEqual([null, null]);
    const auroc = buildSeries(parsed.rounds, "auroc", parsed.sites);
    const scale = buildScale(auroc)!;
    const a = auroc.find((s) => s.id === "site-a")!;
    // y pixel maps back to the stored value
    const invert = (py: number) => scale.yMin + ((DEFAULT_BOX.height - DEFAULT_BOX.bottom - py) / (DEFAULT_BOX.height - DEFAULT_BOX.top - DEFAULT_BOX.bottom)) * (scale.yMax - scale.yMin);
    expect(invert(scale.py(a.points[0].y as number))).toBeCloseTo(0.6, 10);
    const b = auroc.find((s) => s.id === "site-b")!; // round 1 missing: path restarts, no line across the gap
    expect(seriesPath(b.points, scale).split("M").length - 1).toBe(1);
    expect(seriesPath([{ x: 0, y: 0.5 }, { x: 1, y: null }, { x: 2, y: 0.6 }], scale).match(/M/g)).toHaveLength(2);
  });
  it("returns no scale for empty data", () => {
    expect(buildScale([])).toBeNull();
    expect(buildScale([{ id: "x", label: "x", points: [{ x: 0, y: null }] }])).toBeNull();
  });
});

describe("model card", () => {
  const base = {
    studyId: "s", jobId: "j", nvflareJobId: null, modelVersion: "model-v1.0.0", releaseStatus: "APPROVED", generatedAt: new Date("2026-11-04T00:00:00Z"),
    pipelineVersion: "v1", gitCommit: null, imageDigest: null, siteDigests: null, selectedSiteCodes: ["a"], runParameters: null,
    descriptor: readPipelineDescriptor(null), descriptorStatus: "read" as const, descriptorCommitRecordedOnRun: true, metrics: null, metricsChecksum: null, modelChecksum: "abc", approvers: []
  };
  it("marks unstored fields as not recorded and gives no performance when metrics are missing", () => {
    const card = buildModelCard(base);
    expect(card.code.gitCommit).toEqual({ recorded: false });
    expect(card.data.decisionThreshold).toEqual({ recorded: false });
    expect(card.performance).toMatchObject({ status: "missing" });
    expect(JSON.stringify(card)).not.toMatch(/auroc/i);
    expect(card.code.imageSignature.verified).toBe(false);
    expect(card.notices.join(" ")).toMatch(/not.*clinically valid/i);
  });
  it("labels synthetic data and carries only stored metrics", () => {
    const descriptor = readPipelineDescriptor(JSON.stringify({ dataContract: { features: ["a", "b"], dataKind: "synthetic", window: "24h" }, hyperparameters: { seed: 1 } }));
    const card = buildModelCard({ ...base, descriptor, metrics: parseRoundMetricsJsonl(FILE), gitCommit: "abcdef1" });
    expect(card.notices.join(" ")).toMatch(/synthetic/);
    expect(card.data.featureList).toEqual({ recorded: true, value: ["a", "b"] });
    expect(card.data.dataContractHash.recorded).toBe(true);
    expect((card.performance as { rounds: unknown[] }).rounds).toHaveLength(2);
  });
});

describe("model card honesty", () => {
  const base = {
    studyId: "s", jobId: "j", nvflareJobId: null, modelVersion: "v", releaseStatus: "APPROVED", generatedAt: new Date("2026-11-04T00:00:00Z"),
    pipelineVersion: "v1", gitCommit: null, imageDigest: null, siteDigests: null, selectedSiteCodes: ["a"], runParameters: null,
    descriptor: readPipelineDescriptor(null), descriptorStatus: "read" as const, descriptorCommitRecordedOnRun: true, metrics: null, metricsChecksum: null, modelChecksum: "abc", approvers: []
  };
  it("says the data kind is unverified when the descriptor declares none", () => {
    const text = buildModelCard(base).notices.join(" ");
    expect(text).toMatch(/does not declare what kind of data/);
    expect(text).toMatch(/real, synthetic, test or simulated/);
  });
  it("distinguishes a failed descriptor read from a descriptor that declares nothing", () => {
    const card = buildModelCard({ ...base, descriptorStatus: "unavailable" });
    expect(card.notices.join(" ")).toMatch(/could not be read/);
    expect(card.notices.join(" ")).toMatch(/Do not assume the data is real/);
    expect(card.data.descriptorStatus).toBe("unavailable");
    expect(buildModelCard(base).notices.join(" ")).not.toMatch(/could not be read/);
  });
  it("notes when the descriptor was read at a commit the run did not record", () => {
    const card = buildModelCard({ ...base, descriptorCommitRecordedOnRun: false });
    expect(card.notices.join(" ")).toMatch(/no commit recorded on it/);
    expect(card.code.gitCommit).toEqual({ recorded: false });
  });
});

describe("repo path safety", () => {
  it.each(["../x", "a/../../etc/passwd", "/etc/passwd", "a\\b", "%2e%2e/x", "a/%2e%2e/b", "a\0b", ".git/config", "a//b", "C:/x", ""])("rejects %j", (p) => {
    expect(isSafeRepoPath(p)).toBe(false);
  });
  it("accepts normal paths and validates commit shas", () => {
    expect(isSafeRepoPath("job/app/config/config_fed_server.conf")).toBe(true);
    expect(isCommitSha("abcdef1234")).toBe(true);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("abc/../x")).toBe(false);
  });
});

describe("line diff", () => {
  it("reports adds, removals and context", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.some((l) => l.kind === "del" && l.text === "b")).toBe(true);
  });
  it("refuses to diff huge files", () => {
    expect(diffLines("x\n".repeat(3000), "y").tooLarge).toBe(true);
  });
});
