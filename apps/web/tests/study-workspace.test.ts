import { describe, expect, it } from "vitest";
import { parseStudyDetailParam, serializeStudyDetailParam } from "@/lib/study-detail";
import { getStudyWorkspaceSection, normalizeStudyWorkspaceSection, studyActionHref, studyNavHref, activeStudyNavKey, STUDY_NAV_ITEMS } from "@/lib/study-workspace";

describe("study workspace navigation", () => {
  it("shows one sidebar item per destination, with a single Code & run item", () => {
    expect(STUDY_NAV_ITEMS.map((item) => item.label)).toEqual(["Summary", "Protocol", "Sites", "Team", "Code & run", "Results", "Audit"]);
    expect(studyNavHref("s1", "code")).toBe("/studies/s1/projects");
    expect(studyNavHref("s1", "audit")).toBe("/studies/s1/audit");
    expect(studyNavHref("s1", "sites")).toBe("/studies/s1?section=sites");
  });

  it("selects the sidebar item from the route, not a regex on the legacy section", () => {
    expect(activeStudyNavKey("/studies/s1/projects", "overview")).toBe("code");
    expect(activeStudyNavKey("/studies/s1/pipeline-agent", "overview")).toBe("code");
    expect(activeStudyNavKey("/studies/s1/audit", "overview")).toBe("audit");
    expect(activeStudyNavKey("/studies/s1/runs/j1", "overview")).toBe("results");
    expect(activeStudyNavKey("/studies/s1", "sites")).toBe("sites");
    expect(activeStudyNavKey("/studies/s1", "run")).toBe("code");
    expect(activeStudyNavKey("/studies/manage", "overview")).toBeNull();
    expect(activeStudyNavKey("/dashboard", "overview")).toBeNull();
  });

  it("normalizes unknown sections to summary", () => {
    expect(normalizeStudyWorkspaceSection("run")).toBe("run");
    expect(normalizeStudyWorkspaceSection("operations")).toBe("overview");
    expect(getStudyWorkspaceSection("results").title).toBe("Results");
  });

  it("parses and serializes typed detail URL state", () => {
    expect(parseStudyDetailParam("site:site-1")).toEqual({ kind: "site", id: "site-1" });
    expect(parseStudyDetailParam("modelRelease:release:with:colon")).toEqual({
      kind: "modelRelease",
      id: "release:with:colon"
    });
    expect(parseStudyDetailParam("unknown:1")).toBeNull();
    expect(serializeStudyDetailParam({ kind: "experimentRun", id: "job-1" })).toBe("experimentRun:job-1");
  });

  it("sends pipeline and run actions to the Code & run workspace, never a legacy section", () => {
    expect(studyActionHref("s1", "pipeline")).toBe("/studies/s1/projects");
    expect(studyActionHref("s1", "run")).toBe("/studies/s1/projects");
    expect(studyActionHref("s1", "sites")).toBe("/studies/s1?section=sites");
    expect(studyActionHref("s1")).toBe("/studies/s1");
  });
});

describe("results navigation", () => {
  it("sends the sidebar and summary cards to the runs table", () => {
    expect(studyNavHref("s1", "results")).toBe("/studies/s1/runs");
    expect(studyActionHref("s1", "results")).toBe("/studies/s1/runs");
  });
});
