import { describe, expect, it } from "vitest";
import { TEMPLATE_PAGE_SIZE, browseTemplates, filterTemplates, matchesQuery, paginate, recommendedMatch, sortTemplates, type BrowseFields } from "@/lib/pipeline-start";
import { shortFitReason, orderedFitReasons, type FitReport } from "@/lib/template-fit";

const item = (name: string, extra: Partial<BrowseFields> = {}): BrowseFields => ({ name, algorithm: null, task: null, dataType: null, available: true, fit: "partial", ...extra });

describe("matchesQuery", () => {
  const xgb = item("Mortality XGBoost", { algorithm: "XGBoost", task: "binary_classification", dataType: "tabular" });
  it("matches name, algorithm, task and data type, ignoring case", () => {
    expect(matchesQuery(xgb, "mortality")).toBe(true);
    expect(matchesQuery(xgb, "XGBOOST")).toBe(true);
    expect(matchesQuery(xgb, "binary classification")).toBe(true);
    expect(matchesQuery(xgb, "tabular ehr")).toBe(true);
  });
  it("needs every word and treats a blank query as everything", () => {
    expect(matchesQuery(xgb, "mortality imaging")).toBe(false);
    expect(matchesQuery(xgb, "   ")).toBe(true);
    expect(matchesQuery(item("Plain"), "xgboost")).toBe(false);
  });
});

describe("filterTemplates", () => {
  const list = [
    item("A", { task: "regression", dataType: "tabular" }),
    item("B", { task: "survival", dataType: "tabular" }),
    item("C", { task: "regression", dataType: "imaging" })
  ];
  it("filters by task and data type together with the query", () => {
    expect(filterTemplates(list, { task: "regression" }).map((i) => i.name)).toEqual(["A", "C"]);
    expect(filterTemplates(list, { task: "regression", dataType: "imaging" }).map((i) => i.name)).toEqual(["C"]);
    expect(filterTemplates(list, { query: "survival" }).map((i) => i.name)).toEqual(["B"]);
    expect(filterTemplates(list, {}).length).toBe(3);
  });
});

describe("sortTemplates and browseTemplates", () => {
  const list = [
    item("gone", { available: false, fit: "fits" }),
    item("diff", { fit: "different" }),
    item("part", { fit: "partial" }),
    item("best", { fit: "fits" }),
    item("part2", { fit: "partial" })
  ];
  it("puts best fit first, ties stable, unavailable last", () => {
    expect(sortTemplates(list).map((i) => i.name)).toEqual(["best", "part", "part2", "diff", "gone"]);
  });
  it("hides unavailable templates by default and counts them", () => {
    const hidden = browseTemplates(list, {});
    expect(hidden.rows.map((i) => i.name)).toEqual(["best", "part", "part2", "diff"]);
    expect(hidden.unavailableCount).toBe(1);
    const shown = browseTemplates(list, { showUnavailable: true });
    expect(shown.rows.at(-1)?.name).toBe("gone");
    expect(shown.unavailableCount).toBe(1);
  });
  it("counts only unavailable templates that match the search", () => {
    expect(browseTemplates(list, { query: "part" }).unavailableCount).toBe(0);
    expect(browseTemplates(list, { query: "gone" })).toMatchObject({ rows: [], unavailableCount: 1 });
  });
});

describe("paginate", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i);
  it("defaults to ten per page", () => {
    const first = paginate(hundred, 1);
    expect(TEMPLATE_PAGE_SIZE).toBe(10);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ page: 1, pageCount: 10, total: 100, from: 1, to: 10 });
  });
  it("clamps a stale page and handles a partial last page", () => {
    expect(paginate(hundred, 99).page).toBe(10);
    expect(paginate(hundred, 0).page).toBe(1);
    expect(paginate(hundred.slice(0, 23), 3)).toMatchObject({ from: 21, to: 23, pageCount: 3 });
  });
  it("reports an empty list as page 1 of 1 with no range", () => {
    expect(paginate([], 4)).toEqual({ items: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
  });
});

describe("recommendedMatch", () => {
  it("recommends only a genuinely fitting, available template", () => {
    expect(recommendedMatch([item("p"), item("f", { fit: "fits" })])?.name).toBe("f");
    expect(recommendedMatch([item("p"), item("d", { fit: "different" })])).toBeNull();
    expect(recommendedMatch([item("gone", { fit: "fits", available: false })])).toBeNull();
    expect(recommendedMatch([])).toBeNull();
  });
});

describe("short fit text", () => {
  const report: FitReport = {
    fit: "different",
    unknownCount: 1,
    mismatchCount: 1,
    reasons: [
      { aspect: "task", status: "match", message: "Task matches." },
      { aspect: "sites", status: "unknown", message: "A site lists no columns." },
      { aspect: "data_type", status: "mismatch", message: "x".repeat(200) }
    ]
  };
  it("leads with the contradiction and cuts it short", () => {
    expect(orderedFitReasons(report)[0]).toHaveLength(200);
    const short = shortFitReason(report, 40);
    expect(short).toHaveLength(40);
    expect(short.endsWith("…")).toBe(true);
  });
  it("says so when there is nothing to compare", () => {
    expect(shortFitReason({ fit: "partial", unknownCount: 0, mismatchCount: 0, reasons: [] })).toBe("No evidence to compare.");
  });
});
