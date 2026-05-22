import { describe, expect, it } from "vitest";
import { resolveStudyNextAction, summaryReadinessItems } from "@/lib/study-summary";
import { parseStudyDetailParam, serializeStudyDetailParam } from "@/lib/study-detail";
import { getStudyWorkspaceSection, normalizeStudyWorkspaceSection, STUDY_WORKSPACE_SECTIONS } from "@/lib/study-workspace";

describe("study workspace navigation", () => {
  it("uses the health-AI lifecycle section order", () => {
    expect(STUDY_WORKSPACE_SECTIONS.map((section) => section.label)).toEqual([
      "Summary",
      "Protocol",
      "Sites & Data",
      "Team & Access",
      "Pipeline",
      "Run",
      "Results & Releases",
      "Audit"
    ]);
  });

  it("normalizes unknown sections to summary", () => {
    expect(normalizeStudyWorkspaceSection("run")).toBe("run");
    expect(normalizeStudyWorkspaceSection("operations")).toBe("overview");
    expect(getStudyWorkspaceSection("results").title).toBe("Results and releases");
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
    ).toMatchObject({ title: "Submit federated run", section: "run" });
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
});
