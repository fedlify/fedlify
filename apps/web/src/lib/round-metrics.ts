/**
 * Stored per-round metrics (fedlify_metrics.jsonl) -> the numbers the Performance tab and the model card show.
 *
 * Honesty rules, enforced here so every consumer gets them:
 * - Only values present in the file are used. A site that did not report a metric in a round is listed as missing for
 *   that round; it is never counted as zero and never interpolated.
 * - Non-finite or non-numeric values are dropped and counted, not coerced.
 * - The round average is weighted by numSamples only when every contributing site reported a positive numSamples.
 *   Otherwise it is an unweighted mean and says so.
 * - Metrics are scores of the global model on each site's local validation split. They are not held-out test results
 *   and not evidence of clinical validity.
 */

export type RoundSiteValue = { site: string; numSamples: number | null; metrics: Record<string, number> };
export type RoundSummary = {
  round: number;
  sites: RoundSiteValue[];
  /** Round average per metric key, over the sites that reported that key. */
  average: Record<string, number>;
  weighting: Record<string, "samples" | "unweighted">;
  /** Sites that contributed in this round but did not report a given key. */
  missing: Record<string, string[]>;
};

export type ParsedRoundMetrics = {
  rounds: RoundSummary[];
  metricKeys: string[];
  sites: string[];
  recordCount: number;
  /** Lines that were not valid JSON objects. */
  malformedLines: number;
  /** Metric values dropped because they were not finite numbers. */
  droppedValues: number;
};

export const METRICS_DISCLAIMER =
  "Scores of the global model on each site's local validation split. They are not a held-out test and are not evidence of clinical validity.";

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

export function parseRoundMetricsJsonl(text: string): ParsedRoundMetrics {
  let malformedLines = 0;
  let droppedValues = 0;
  let recordCount = 0;
  const byRound = new Map<number, Map<string, RoundSiteValue>>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      malformedLines += 1;
      continue;
    }
    recordCount += 1;
    const r = record as Record<string, unknown>;
    if (r.event !== "contribution") continue;
    const round = finite(r.round);
    const site = typeof r.site === "string" && r.site ? r.site : null;
    if (round === null || !Number.isInteger(round) || !site) continue;
    const metrics: Record<string, number> = {};
    if (r.metrics && typeof r.metrics === "object" && !Array.isArray(r.metrics)) {
      for (const [key, value] of Object.entries(r.metrics as Record<string, unknown>)) {
        const n = finite(value);
        if (n === null) droppedValues += 1;
        else metrics[key] = n;
      }
    }
    const samples = finite(r.numSamples);
    const sites = byRound.get(round) ?? new Map<string, RoundSiteValue>();
    // A repeated (round, site) record replaces the earlier one: the file is append-only, the last write wins.
    sites.set(site, { site, numSamples: samples !== null && samples > 0 ? samples : null, metrics });
    byRound.set(round, sites);
  }

  const rounds: RoundSummary[] = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, siteMap]) => {
      const sites = [...siteMap.values()].sort((a, b) => a.site.localeCompare(b.site));
      const keys = [...new Set(sites.flatMap((s) => Object.keys(s.metrics)))].sort();
      const average: Record<string, number> = {};
      const weighting: Record<string, "samples" | "unweighted"> = {};
      const missing: Record<string, string[]> = {};
      for (const key of keys) {
        const reporting = sites.filter((s) => key in s.metrics);
        const absent = sites.filter((s) => !(key in s.metrics)).map((s) => s.site);
        if (absent.length) missing[key] = absent;
        const weighted = reporting.every((s) => s.numSamples !== null);
        if (weighted) {
          const total = reporting.reduce((sum, s) => sum + (s.numSamples as number), 0);
          average[key] = reporting.reduce((sum, s) => sum + s.metrics[key] * (s.numSamples as number), 0) / total;
        } else {
          average[key] = reporting.reduce((sum, s) => sum + s.metrics[key], 0) / reporting.length;
        }
        weighting[key] = weighted ? "samples" : "unweighted";
      }
      return { round, sites, average, weighting, missing };
    });

  return {
    rounds,
    metricKeys: [...new Set(rounds.flatMap((r) => Object.keys(r.average)))].sort(),
    sites: [...new Set(rounds.flatMap((r) => r.sites.map((s) => s.site)))].sort(),
    recordCount,
    malformedLines,
    droppedValues
  };
}

export type MetricsSummary = {
  roundCount: number;
  lastRound: number | null;
  metricKeys: string[];
  sites: string[];
  /** Best round average of the key metric, with its round. Null when the metric was never reported. */
  best: { key: string; value: number; round: number } | null;
  /** Round average of the key metric in the last stored round. */
  last: { key: string; value: number; round: number } | null;
};

/** Metric used for "best". AUROC when present; otherwise nothing is chosen for the user. */
export const KEY_METRIC = "auroc";

export function summarizeMetrics(parsed: ParsedRoundMetrics, key = KEY_METRIC): MetricsSummary {
  const points = parsed.rounds.filter((r) => key in r.average).map((r) => ({ key, value: r.average[key], round: r.round }));
  const best = points.length ? points.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  return {
    roundCount: parsed.rounds.length,
    lastRound: parsed.rounds.length ? parsed.rounds[parsed.rounds.length - 1].round : null,
    metricKeys: parsed.metricKeys,
    sites: parsed.sites,
    best,
    last: points.length ? points[points.length - 1] : null
  };
}

/** Narrow an untrusted stored JSON value to a MetricsSummary, or null. */
export function readMetricsSummary(value: unknown): MetricsSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.roundCount !== "number") return null;
  return value as MetricsSummary;
}

/** Serialise API records (live fallback) into the jsonl shape the metrics collector writes. */
export function recordsToJsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

/**
 * What a site operator may see: their own sites' rows, and a round average for a metric only where at least `minSites`
 * sites reported THAT metric (counting reporters per key, not sites in the round: with two reporters the average plus
 * your own value would reveal the other site's value). Other sites' sample counts are never shown, and file-level
 * counters that describe other sites' records are zeroed. `allowedSites` null means no restriction.
 */
export function scopeRoundMetrics(parsed: ParsedRoundMetrics, allowedSites: ReadonlySet<string> | null, minSites = 3): ParsedRoundMetrics & { aggregateHidden: boolean } {
  if (!allowedSites) return { ...parsed, aggregateHidden: false };
  let aggregateHidden = false;
  const rounds = parsed.rounds.map((round) => {
    const average: Record<string, number> = {};
    const weighting: Record<string, "samples" | "unweighted"> = {};
    for (const key of Object.keys(round.average)) {
      const reporters = round.sites.filter((s) => key in s.metrics).length;
      if (reporters >= minSites) {
        average[key] = round.average[key];
        weighting[key] = round.weighting[key];
      } else aggregateHidden = true;
    }
    const ownSites = round.sites.filter((s) => allowedSites.has(s.site));
    // A metric name only one of the other sites reports is that site's data; do not name it.
    const visibleKeys = new Set([...Object.keys(average), ...ownSites.flatMap((s) => Object.keys(s.metrics))]);
    const missing: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(round.missing)) {
      const own = list.filter((site) => allowedSites.has(site));
      if (own.length && visibleKeys.has(key)) missing[key] = own;
    }
    return { round: round.round, sites: ownSites, average, weighting, missing };
  });
  const sites = parsed.sites.filter((s) => allowedSites.has(s));
  const metricKeys = [...new Set(rounds.flatMap((r) => [...Object.keys(r.average), ...r.sites.flatMap((s) => Object.keys(s.metrics))]))].sort();
  const recordCount = rounds.reduce((n, r) => n + r.sites.length, 0);
  return { rounds, metricKeys, sites, recordCount, malformedLines: 0, droppedValues: 0, aggregateHidden };
}
