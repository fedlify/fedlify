import { describe, expect, it } from "vitest";
import { activationGate, missingProtocolFields, pipelineExecutionGate } from "@/lib/governance";

const completeProtocol = {
  title: "Cross-site sepsis model",
  goal: "Validate a governed federated workflow.",
  researchQuestion: "Can local sites train without moving raw data?",
  clinicalUseCase: "Sepsis risk prediction",
  population: "Adult ICU cohort",
  dataModalities: "EHR, labs",
  primaryOutcome: "AUROC",
  intendedUse: "Research validation"
};

describe("governance gates", () => {
  it("requires protocol metadata before activation", () => {
    expect(missingProtocolFields({ title: "Only title" })).toContain("goal");
  });

  it("allows activation only after metadata, site, and ethics clearance", () => {
    const gate = activationGate({
      ...completeProtocol,
      ethics: [{ status: "APPROVED" }],
      studySites: [{ id: "site-1" }]
    });

    expect(gate.allowed).toBe(true);
    expect(gate.status).toBe("APPROVED");
  });

  it("blocks execution without approved version and ready sites", () => {
    const gate = pipelineExecutionGate({
      ethicsStatus: "APPROVED",
      pipelineApprovalStatus: "VALIDATED",
      pipelineValidationStatus: "PASSED",
      readinessChecks: [{ status: "PENDING" }]
    });

    expect(gate.allowed).toBe(false);
    expect(gate.missing).toEqual(["approvedPipelineVersion", "allSitesReady"]);
  });

  it("allows execution after ethics, approval, validation, and readiness", () => {
    expect(
      pipelineExecutionGate({
        ethicsStatus: "NOT_REQUIRED",
        pipelineApprovalStatus: "APPROVED",
        pipelineValidationStatus: "PASSED",
        readinessChecks: [{ status: "PASSED" }]
      }).allowed
    ).toBe(true);
  });
});
