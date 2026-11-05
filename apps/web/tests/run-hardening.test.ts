import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const caps = new Set<string>();
const releaseFind = vi.fn();
const artifactUpdate = vi.fn();
const siteFind = vi.fn();
const jobFindUnique = vi.fn();
const readGitea = vi.fn();

vi.mock("@/lib/api", () => ({ requireUser: async () => ({ userId: "u1" }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/rbac", () => ({ canAccessStudy: async (_u: string, _s: string, a: string) => caps.has(a) }));
vi.mock("@/lib/storage", () => ({ storageConfigured: () => true, createPresignedDownloadUrl: async (k: string) => `https://s3.test/${k}` }));
vi.mock("@/lib/gitea", () => ({ readGiteaFileAtRef: (...a: unknown[]) => readGitea(...a) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    modelRelease: { findUnique: (...a: unknown[]) => releaseFind(...a) },
    modelArtifact: { update: (...a: unknown[]) => artifactUpdate(...a) },
    studySite: { findMany: (...a: unknown[]) => siteFind(...a) },
    nvflareJob: { findUnique: (...a: unknown[]) => jobFindUnique(...a) }
  }
}));

import { GET as download } from "@/app/api/v1/model-releases/[releaseId]/download/route";
import { AuditPartialNotice } from "@/components/AuditPartialNotice";
import { RunCodeView } from "@/components/RunCodeView";
import { RoundMetricsChart, type MetricsPayload } from "@/components/RoundMetricsChart";
import { siteStyle, thinRoundLabels } from "@/lib/chart-geometry";
import { parseRoundMetricsJsonl, scopeRoundMetrics } from "@/lib/round-metrics";
import { artifactVisibleToViewer, buildCardForJob, LOG_MAX_BYTES, redactLogText } from "@/lib/run-evidence";

const rec = (round: number, site: string, metrics: Record<string, number>, numSamples = 10) => JSON.stringify({ event: "contribution", round, site, numSamples, metrics });

describe("scopeRoundMetrics counts reporters per metric", () => {
  it("hides an average that only two sites reported, even when three sites are in the round", () => {
    const parsed = parseRoundMetricsJsonl([rec(0, "a", { auroc: 0.5, loss: 1 }), rec(0, "b", { auroc: 0.7, loss: 2 }), rec(0, "c", { loss: 3 })].join("\n"));
    const scoped = scopeRoundMetrics(parsed, new Set(["a"]));
    expect(scoped.rounds[0].average.loss).toBeCloseTo(2, 10); // three reporters: shown
    expect("auroc" in scoped.rounds[0].average).toBe(false); // two reporters: 2*avg - own would reveal b
    expect("auroc" in scoped.rounds[0].weighting).toBe(false);
    expect(scoped.aggregateHidden).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain("0.7");
  });
  it("does not leak other sites through key lists or file counters", () => {
    const parsed = parseRoundMetricsJsonl([rec(0, "a", { auroc: 0.5 }), rec(0, "b", { secret_b_metric: 0.9 }), "not json"].join("\n"));
    const scoped = scopeRoundMetrics(parsed, new Set(["a"]));
    expect(scoped.metricKeys).toEqual(["auroc"]);
    expect(scoped.sites).toEqual(["a"]);
    expect(scoped.malformedLines).toBe(0);
    expect(scoped.recordCount).toBe(1);
    expect(JSON.stringify(scoped)).not.toContain("secret_b_metric");
  });
  it("is unchanged for unrestricted viewers", () => {
    const parsed = parseRoundMetricsJsonl(rec(0, "a", { auroc: 0.5 }));
    expect(scopeRoundMetrics(parsed, null)).toMatchObject({ aggregateHidden: false, metricKeys: ["auroc"] });
  });
});

describe("redactLogText", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRETKEYBODY\n-----END RSA PRIVATE KEY-----";
  it("masks a private key whose BEGIN line would fall before the truncation point", () => {
    const text = `${"x".repeat(50)}\n${key}\n${"y".repeat(LOG_MAX_BYTES - 40)}`;
    const out = redactLogText(text);
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain("SUPERSECRETKEYBODY");
    expect(out.text).not.toContain("PRIVATE KEY");
  });
  it("caps by bytes, not characters", () => {
    const out = redactLogText("é".repeat(LOG_MAX_BYTES));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(LOG_MAX_BYTES);
  });
  it("passes short text through, masking secrets", () => {
    expect(redactLogText("ok password=hunter2")).toEqual({ text: "ok [redacted]", truncated: false });
  });
});

describe("artifactVisibleToViewer", () => {
  it("keeps logs for managers and round metrics and the card for the full scope", () => {
    const site = { scope: "site" as const, canViewLogs: false };
    expect(["LOG", "ROUND_METRICS", "MODEL_CARD"].map((k) => artifactVisibleToViewer(k, site))).toEqual([false, false, false]);
    expect(artifactVisibleToViewer("AGGREGATED_MODEL", site)).toBe(true);
    const reviewer = { scope: "full" as const, canViewLogs: false };
    expect(artifactVisibleToViewer("ROUND_METRICS", reviewer)).toBe(true);
    expect(artifactVisibleToViewer("LOG", reviewer)).toBe(false);
    expect(artifactVisibleToViewer("LOG", { scope: "full", canViewLogs: true })).toBe(true);
  });
});

describe("model release download respects run evidence scoping", () => {
  const artifacts = [
    { id: "a-log", kind: "LOG", filename: "log.txt", storageKey: "k/log" },
    { id: "a-met", kind: "ROUND_METRICS", filename: "fedlify_metrics.jsonl", storageKey: "k/met" },
    { id: "a-card", kind: "MODEL_CARD", filename: "model-card.json", storageKey: "k/card" },
    { id: "a-model", kind: "AGGREGATED_MODEL", filename: "model.npy", storageKey: "k/model" }
  ];
  const ask = async (artifactId?: string) =>
    (await (download as never as (r: unknown, c: unknown) => Promise<Response>)({ nextUrl: new URL(`https://app.test/x${artifactId ? `?artifactId=${artifactId}` : ""}`) }, { params: Promise.resolve({ releaseId: "r1" }) }))!;
  beforeEach(() => {
    caps.clear();
    vi.clearAllMocks();
    releaseFind.mockResolvedValue({ id: "r1", studyId: "s1", status: "APPROVED", version: "v1", artifacts, study: { orgId: "o" } });
    siteFind.mockResolvedValue([{ code: "A" }]);
  });
  it.each(["a-log", "a-met", "a-card"])("refuses a site admin the %s artifact", async (id) => {
    ["read", "downloadRelease", "viewLogs"].forEach((c) => caps.add(c));
    expect((await ask(id)).status).toBe(403);
    expect(artifactUpdate).not.toHaveBeenCalled();
  });
  it("still lets a site admin download the model, and defaults to it rather than the log", async () => {
    ["read", "downloadRelease", "viewLogs"].forEach((c) => caps.add(c));
    expect((await ask("a-model")).status).toBe(200);
    const body = await (await ask()).json();
    expect(body.artifact.id).toBe("a-model");
  });
  it("lets a manager download metrics and the log", async () => {
    ["read", "downloadRelease", "manage", "audit"].forEach((c) => caps.add(c));
    expect((await ask("a-met")).status).toBe(200);
    expect((await ask("a-log")).status).toBe(200);
  });
});

describe("model card commit and descriptor honesty", () => {
  const job = (gitCommit: string | null) => ({
    id: "j", studyId: "s", nvflareJobId: "n", gitCommit, imageDigest: null, siteDigests: null, selectedSites: [{ code: "A" }], runParameters: null,
    pipelineVersion: { version: "v1", gitCommit: "abcdef1234", project: { giteaOwner: "o", giteaRepo: "r" } }
  });
  const input = { modelVersion: "v", releaseStatus: "DRAFT", metricsBody: null, metricsChecksum: null, modelChecksum: null, approvers: [] };
  it("does not present the pipeline version's commit as the run's commit", async () => {
    jobFindUnique.mockResolvedValue(job(null));
    readGitea.mockResolvedValue(null);
    const card = (await buildCardForJob("j", input))!;
    expect(card.code.gitCommit).toEqual({ recorded: false });
    expect(readGitea.mock.calls[0][0].ref).toBe("abcdef1234"); // descriptor lookup only
    expect(card.notices.join(" ")).toMatch(/no commit recorded on it/);
  });
  it("records the run's own commit", async () => {
    jobFindUnique.mockResolvedValue(job("1234567890abcdef"));
    readGitea.mockResolvedValue("{}");
    expect((await buildCardForJob("j", input))!.code.gitCommit).toEqual({ recorded: true, value: "1234567890abcdef" });
  });
  it("labels a failed Gitea read instead of silently omitting the data-kind notice", async () => {
    jobFindUnique.mockResolvedValue(job("1234567890abcdef"));
    readGitea.mockRejectedValue(new Error("gitea down"));
    const card = (await buildCardForJob("j", input))!;
    expect(card.data.descriptorStatus).toBe("unavailable");
    expect(card.notices.join(" ")).toMatch(/could not be read/);
  });
});

describe("RoundMetricsChart rendering", () => {
  const payload = (text: string, extra: Partial<MetricsPayload> = {}): MetricsPayload => {
    const p = parseRoundMetricsJsonl(text);
    return { status: "stored", disclaimer: "DISCLAIMER", rounds: p.rounds, metricKeys: p.metricKeys, sites: p.sites, ...extra };
  };
  const html = (m: MetricsPayload) => renderToStaticMarkup(createElement(RoundMetricsChart, { metrics: m }));
  it("renders the empty state for missing metrics, with no chart", () => {
    const out = html({ status: "missing", reason: "No round metrics were captured for this run.", disclaimer: "d" });
    expect(out).toContain('data-testid="metrics-empty"');
    expect(out).toContain("No round metrics stored for this run");
    expect(out).not.toContain("data-y=");
    expect(out).not.toContain('data-testid="metrics-chart"');
  });
  it("plots exactly the stored values", () => {
    const out = html(payload([rec(0, "a", { auroc: 0.6 }), rec(1, "a", { auroc: 0.8 })].join("\n")));
    const ys = [...out.matchAll(/data-y="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(ys.sort()).toEqual([0.6, 0.6, 0.8, 0.8].sort()); // site series plus single-site average
    expect(out).toContain("0.8000");
  });
  it("marks a gap as missing and an average over only some sites as partial", () => {
    const out = html(payload([rec(0, "a", { auroc: 0.6 }), rec(0, "b", { auroc: 0.8 }), rec(0, "c", { loss: 1 })].join("\n")));
    expect(out).toContain("Missing");
    expect(out).toContain("partial, no auroc from c");
    expect(out).toContain('data-testid="partial-note"');
  });
  it("shows the data-kind caveat, the weighting caveat and the live label", () => {
    const out = html(payload(rec(0, "a", { auroc: 0.6 }), { status: "live" }));
    expect(out).toContain('data-testid="data-kind-note"');
    expect(out).toMatch(/synthetic, test or simulated/);
    expect(out).toMatch(/may be training rows/);
    expect(out).toContain("Live values from the running aggregator");
  });
  it("labels a hidden average as hidden for site operators", () => {
    const out = html(payload(rec(0, "a", { auroc: 0.6 }), { aggregateHidden: true, rounds: [{ round: 0, sites: [{ site: "a", numSamples: 10, metrics: { auroc: 0.6 } }], average: {}, weighting: {}, missing: {} }] }));
    expect(out).toContain("Hidden");
  });
  it("thins x labels on long runs and gives every site series a distinct style", () => {
    const text = Array.from({ length: 60 }, (_, i) => rec(i, "a", { auroc: 0.5 + i / 200 })).join("\n");
    const out = html(payload(text));
    const labels = [...out.matchAll(/<text[^>]*text-anchor="middle"[^>]*>(\d+)<\/text>/g)].map((m) => Number(m[1]));
    expect(labels.length).toBeLessThanOrEqual(11);
    expect(labels[0]).toBe(0);
    expect(labels).toContain(59);
  });
});

describe("chart helpers", () => {
  it("thinRoundLabels keeps first and last and caps the count", () => {
    const rounds = Array.from({ length: 100 }, (_, i) => i);
    const picked = thinRoundLabels(rounds, 10);
    expect(picked.length).toBeLessThanOrEqual(11);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(99);
    expect(thinRoundLabels([0, 1, 2])).toEqual([0, 1, 2]);
  });
  it("siteStyle never repeats a colour and dash pair for 20 sites", () => {
    const seen = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(siteStyle(i, 10))));
    expect(seen.size).toBe(20);
  });
});

describe("run metrics capture migration", () => {
  const root = new URL("..", import.meta.url).pathname;
  const sql = readFileSync(`${root}prisma/migrations/20261108090000_run_metrics_capture/migration.sql`, "utf8");
  const schema = readFileSync(`${root}prisma/schema.prisma`, "utf8");
  it("is additive and matches the schema", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME|SET NOT NULL)\b/i);
    for (const col of ["metricsJsonl", "metricsChecksum", "metricsCapturedAt"]) {
      expect(sql).toContain(`ADD COLUMN "${col}"`);
      expect(schema).toMatch(new RegExp(`model NvflareJob \\{[\\s\\S]*?\\n  ${col}\\s+(String|DateTime)\\?`));
    }
  });
});

describe("run code view and audit notice rendering", () => {
  const view = (extra: Record<string, unknown> = {}) => ({
    commit: "abc123", commitRecordedOnRun: true, imageDigest: "sha256:img", siteDigests: [{ site: "A", imageDigest: "sha256:sitea" }, { site: "B", imageDigest: null }],
    treeTruncated: false, commitUrl: "https://git/c", pipelineVersion: "v2", parent: null, files: [{ path: "a.py", status: "unknown" }], deletedPaths: [],
    file: { path: "a.py", content: "print(1)", truncated: false, parentContentMissing: false, diff: null }, ...extra
  });
  const render = (v: unknown) => renderToStaticMarkup(createElement(RunCodeView, { view: v as never, onSelect: () => undefined }));
  it("shows the image digest and per-site digests on the Code tab, with unreported sites labelled", () => {
    const out = render(view());
    expect(out).toContain("sha256:img");
    expect(out).toContain("sha256:sitea");
    expect(out).toMatch(/Site B reported:.*not reported/);
  });
  it("flags a commit that was reconstructed from the pipeline version", () => {
    expect(render(view())).not.toContain("Not recorded on this run");
    expect(render(view({ commitRecordedOnRun: false }))).toMatch(/Not recorded on this run.*pipeline version v2/);
  });
  it("surfaces a truncated tree and an unreadable parent file", () => {
    expect(render(view({ treeTruncated: true }))).toContain("The file list is incomplete");
    expect(render(view())).not.toContain("The file list is incomplete");
    const out = render(view({ file: { path: "a.py", content: "x", truncated: false, parentContentMissing: true, diff: null } }));
    expect(out).toContain("previous version of this file could not be read");
  });
  it("wraps instead of using a fixed two-column grid", () => {
    const out = render(view());
    expect(out).toMatch(/data-testid="code-layout"[^>]*flex-wrap:\s*wrap/);
    expect(out).not.toContain("grid-template-columns");
  });
  it("says when the audit table is partial, and stays quiet when complete or unknown", () => {
    expect(renderToStaticMarkup(createElement(AuditPartialNotice, { shown: 100, total: 250 }))).toContain("Showing the latest 100 of 250 audit events");
    expect(renderToStaticMarkup(createElement(AuditPartialNotice, { shown: 100, total: 100 }))).toBe("");
    expect(renderToStaticMarkup(createElement(AuditPartialNotice, { shown: null, total: null }))).toBe("");
  });
});
