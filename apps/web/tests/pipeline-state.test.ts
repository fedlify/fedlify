import { describe, expect, it } from "vitest";
import { approvedTemplateCatalog } from "@/lib/workflow-copy";
import { pipelineExecutionGate } from "@/lib/governance";

// ── Helpers that mirror the study pipeline panel state logic ─────────────────

type PipelineVersion = { approvalStatus: string; validationStatus: string };
type PipelineProposal = { status: string };
type PipelineProject = { versions: PipelineVersion[]; proposals: PipelineProposal[] };

function derivePipelineState(projects: PipelineProject[]): "A" | "B" | "C" {
  const versions = projects.flatMap((p) => p.versions);
  const proposals = projects.flatMap((p) => p.proposals);
  const approvedVersions = versions.filter((v) => v.approvalStatus === "APPROVED");
  const isStateA = versions.length === 0 && proposals.length === 0;
  if (isStateA) return "A";
  if (approvedVersions.length > 0) return "C";
  return "B";
}

function hasApprovableVersion(projects: PipelineProject[]): boolean {
  return projects
    .flatMap((p) => p.versions)
    .some((v) => v.validationStatus === "PASSED" && v.approvalStatus !== "APPROVED");
}

// ── Pipeline state machine tests ─────────────────────────────────────────────

describe("pipeline panel state derivation", () => {
  it("State A when no projects exist", () => {
    expect(derivePipelineState([])).toBe("A");
  });

  it("State A when project has no versions or proposals", () => {
    expect(derivePipelineState([{ versions: [], proposals: [] }])).toBe("A");
  });

  it("State B when proposals exist but no approved version", () => {
    expect(
      derivePipelineState([
        { versions: [{ approvalStatus: "VALIDATED", validationStatus: "PASSED" }], proposals: [{ status: "OPEN" }] }
      ])
    ).toBe("B");
  });

  it("State B when versions exist but none approved", () => {
    expect(
      derivePipelineState([
        { versions: [{ approvalStatus: "DRAFT", validationStatus: "QUEUED" }], proposals: [] }
      ])
    ).toBe("B");
  });

  it("State C when at least one version is approved", () => {
    expect(
      derivePipelineState([
        {
          versions: [
            { approvalStatus: "APPROVED", validationStatus: "PASSED" },
            { approvalStatus: "DRAFT", validationStatus: "QUEUED" }
          ],
          proposals: [{ status: "MERGED" }]
        }
      ])
    ).toBe("C");
  });

  it("State C even if other projects have no approved versions", () => {
    expect(
      derivePipelineState([
        { versions: [], proposals: [] },
        { versions: [{ approvalStatus: "APPROVED", validationStatus: "PASSED" }], proposals: [] }
      ])
    ).toBe("C");
  });
});

describe("approvable version detection", () => {
  it("returns true when a validated-but-not-approved version exists", () => {
    expect(
      hasApprovableVersion([
        { versions: [{ validationStatus: "PASSED", approvalStatus: "VALIDATED" }], proposals: [] }
      ])
    ).toBe(true);
  });

  it("returns false when the validated version is already approved", () => {
    expect(
      hasApprovableVersion([
        { versions: [{ validationStatus: "PASSED", approvalStatus: "APPROVED" }], proposals: [] }
      ])
    ).toBe(false);
  });

  it("returns false when validation has not passed", () => {
    expect(
      hasApprovableVersion([
        { versions: [{ validationStatus: "QUEUED", approvalStatus: "DRAFT" }], proposals: [] }
      ])
    ).toBe(false);
  });

  it("returns true when mixed versions include one approvable", () => {
    expect(
      hasApprovableVersion([
        {
          versions: [
            { validationStatus: "PASSED", approvalStatus: "APPROVED" },
            { validationStatus: "PASSED", approvalStatus: "VALIDATED" }
          ],
          proposals: []
        }
      ])
    ).toBe(true);
  });
});

// ── approvedTemplateCatalog filter ───────────────────────────────────────────

describe("approvedTemplateCatalog", () => {
  const makeTemplate = (overrides: Record<string, unknown>) => ({
    id: "t1",
    name: "Test template",
    templateKey: "test-template",
    scope: "PUBLIC_TEMPLATE",
    status: "APPROVED",
    active: true,
    currentApprovedVersion: {
      id: "v1",
      version: "1.0.0",
      approvalStatus: "APPROVED",
      validationStatus: "PASSED",
      gitCommit: "abc123"
    },
    ...overrides
  });

  it("includes fully approved templates", () => {
    const catalog = approvedTemplateCatalog([makeTemplate({})]);
    expect(catalog).toHaveLength(1);
  });

  it("excludes templates where currentApprovedVersion.approvalStatus is not APPROVED", () => {
    const catalog = approvedTemplateCatalog([
      makeTemplate({
        currentApprovedVersion: { id: "v1", version: "1.0.0", approvalStatus: "DRAFT", validationStatus: "PASSED", gitCommit: "abc" }
      })
    ]);
    expect(catalog).toHaveLength(0);
  });

  it("excludes templates where currentApprovedVersion.validationStatus is not PASSED", () => {
    const catalog = approvedTemplateCatalog([
      makeTemplate({
        currentApprovedVersion: { id: "v1", version: "1.0.0", approvalStatus: "APPROVED", validationStatus: "QUEUED", gitCommit: "abc" }
      })
    ]);
    expect(catalog).toHaveLength(0);
  });

  it("excludes templates with no currentApprovedVersion", () => {
    const catalog = approvedTemplateCatalog([makeTemplate({ currentApprovedVersion: null })]);
    expect(catalog).toHaveLength(0);
  });

  it("handles an empty list", () => {
    expect(approvedTemplateCatalog([])).toHaveLength(0);
  });
});

// ── Execution gate (extended coverage) ───────────────────────────────────────

describe("pipelineExecutionGate extended", () => {
  it("blocks when ethics not cleared", () => {
    const gate = pipelineExecutionGate({
      ethicsStatus: "PENDING",
      pipelineApprovalStatus: "APPROVED",
      pipelineValidationStatus: "PASSED",
      readinessChecks: [{ status: "PASSED" }]
    });
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toContain("ethicsApproval");
  });

  it("blocks when any site is not ready", () => {
    const gate = pipelineExecutionGate({
      ethicsStatus: "APPROVED",
      pipelineApprovalStatus: "APPROVED",
      pipelineValidationStatus: "PASSED",
      readinessChecks: [{ status: "PASSED" }, { status: "PENDING" }]
    });
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toContain("allSitesReady");
  });

  it("blocks when no readiness checks exist (no sites)", () => {
    const gate = pipelineExecutionGate({
      ethicsStatus: "APPROVED",
      pipelineApprovalStatus: "APPROVED",
      pipelineValidationStatus: "PASSED",
      readinessChecks: []
    });
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toContain("readySites");
  });

  it("allows execution when all four conditions pass", () => {
    expect(
      pipelineExecutionGate({
        ethicsStatus: "APPROVED",
        pipelineApprovalStatus: "APPROVED",
        pipelineValidationStatus: "PASSED",
        readinessChecks: [{ status: "PASSED" }, { status: "PASSED" }]
      }).allowed
    ).toBe(true);
  });
});
