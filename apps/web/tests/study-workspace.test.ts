import { describe, expect, it } from "vitest";
import { resolveStudyNextAction, summaryReadinessItems } from "@/lib/study-summary";
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

  it("resolves the summary next action from the first blocking runtime gate", () => {
    expect(resolveStudyNextAction({ status: "DRAFT", governanceStatus: "INCOMPLETE", ethics: [] })).toMatchObject({
      title: "Record ethics decision",
      section: "protocol"
    });

    expect(
      resolveStudyNextAction({
        status: "ACTIVE",
        ethics: [{ status: "APPROVED" }],
        pipelineProjects: [{ versions: [{ validationStatus: "PASSED", approvalStatus: "PENDING" }] }]
      })
    ).toMatchObject({ title: "Approve a pipeline version", section: "pipeline" });

    expect(
      resolveStudyNextAction({
        status: "ACTIVE",
        ethics: [{ status: "APPROVED" }],
        pipelineProjects: [{ versions: [{ validationStatus: "PASSED", approvalStatus: "APPROVED" }] }],
        studySites: [{ readinessChecks: [{ status: "PASSED" }], nvflareStatuses: [{ status: "CONNECTED" }] }]
      })
    ).toMatchObject({ title: "Provision aggregator", section: "run" });

    expect(
      resolveStudyNextAction({
        status: "ACTIVE",
        ethics: [{ status: "APPROVED" }],
        pipelineProjects: [{ versions: [{ approvalStatus: "APPROVED" }] }],
        studySites: [{ readinessChecks: [{ status: "PASSED" }], nvflareStatuses: [{ status: "CONNECTED" }] }],
        nvflareDeployments: [{ active: true, status: "ACTIVE", serverAddress: "localhost:18010" }]
      })
    ).toMatchObject({ title: "Start run", section: "run" });
  });

  it("maps summary readiness items to explicit user actions", () => {
    const items = summaryReadinessItems({
      status: "ACTIVE",
      ethics: [{ status: "APPROVED" }],
      pipelineProjects: [{ versions: [{ approvalStatus: "APPROVED" }] }],
      studySites: [{ readinessChecks: [{ status: "PENDING" }], nvflareStatuses: [{ status: "OFFLINE" }] }],
      nvflareDeployments: [{ active: true, status: "ACTIVE", serverAddress: "localhost:18010" }]
    });

    expect(items.map((item) => item.label)).toEqual([
      "Study protocol",
      "Sites",
      "Pipeline",
      "Run",
      "Results"
    ]);
    expect(items.find((item) => item.key === "sites")).toMatchObject({
      state: "needs_attention",
      buttonLabel: "Open sites",
      section: "sites"
    });
  });

  it("sends pipeline and run actions to the Code & run workspace, never a legacy section", () => {
    expect(studyActionHref("s1", "pipeline")).toBe("/studies/s1/projects");
    expect(studyActionHref("s1", "run")).toBe("/studies/s1/projects");
    expect(studyActionHref("s1", "sites")).toBe("/studies/s1?section=sites");
    expect(studyActionHref("s1")).toBe("/studies/s1");
    for (const item of [
      resolveStudyNextAction({ status: "ACTIVE", ethics: [{ status: "APPROVED" }] }),
      ...summaryReadinessItems({ status: "ACTIVE" })
    ]) {
      expect(studyActionHref("s1", item.section)).not.toMatch(/section=(pipeline|run)/);
    }
  });
});

describe("results navigation", () => {
  it("sends the sidebar and summary cards to the runs table", () => {
    expect(studyNavHref("s1", "results")).toBe("/studies/s1/runs");
    expect(studyActionHref("s1", "results")).toBe("/studies/s1/runs");
  });
});
