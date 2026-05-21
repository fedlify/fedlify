import { describe, expect, it } from "vitest";
import {
  approvedTemplateCatalog,
  federatedRunState,
  pipelineVersionState,
  templateScopeLabel,
  templateSourceLabel,
  templateVersionLabel
} from "@/lib/workflow-copy";

describe("workflow copy helpers", () => {
  it("labels public and study template sources consistently", () => {
    expect(templateScopeLabel({ scope: "PUBLIC_TEMPLATE" })).toBe("Public template");
    expect(templateScopeLabel({ scope: "STUDY_TEMPLATE" })).toBe("Study template");
    expect(templateVersionLabel({ version: "1.0.0", gitCommit: "abcdef1234567890" })).toBe("1.0.0 · abcdef123456");
    expect(
      templateSourceLabel(
        { scope: "PUBLIC_TEMPLATE", name: "FedAvg" },
        { version: "1.0.0", gitCommit: "abcdef1234567890" }
      )
    ).toBe("Public template · FedAvg · 1.0.0 · abcdef123456");
  });

  it("filters selectable template sources to approved and validated commits", () => {
    const templates = [
      { id: "ready", currentApprovedVersion: { approvalStatus: "APPROVED", validationStatus: "PASSED" } },
      { id: "pending", currentApprovedVersion: { approvalStatus: "PENDING", validationStatus: "PASSED" } },
      { id: "failed", currentApprovedVersion: { approvalStatus: "APPROVED", validationStatus: "FAILED" } }
    ];

    expect(approvedTemplateCatalog(templates).map((template) => template.id)).toEqual(["ready"]);
  });

  it("uses researcher-facing state labels for pipeline versions and federated runs", () => {
    expect(pipelineVersionState({ approvalStatus: "APPROVED", validationStatus: "PASSED" })).toBe("Approved for federated runs");
    expect(pipelineVersionState({ approvalStatus: "PENDING", validationStatus: "PASSED" })).toBe("Validated, awaiting approval");
    expect(federatedRunState({ status: "SUBMITTED" })).toBe("Submitted");
    expect(federatedRunState({ status: "COMPLETED" })).toBe("Completed");
  });
});
