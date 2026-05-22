import { describe, expect, it } from "vitest";
import { activationGate, missingProtocolFields, pipelineExecutionGate } from "@/lib/governance";

const completeProtocol = {
  title: "Cross-site sepsis model",
  goal: "Validate a governed federated workflow.",
  researchQuestion: "Can local sites train without moving raw data?",
  studyDesign: "Prospective federated health AI validation study.",
  clinicalUseCase: "Sepsis risk prediction",
  population: "Adult ICU cohort",
  eligibilityCriteria: "Adults admitted to participating ICUs with locally available sepsis risk features.",
  dataModalities: "EHR, labs",
  primaryOutcome: "AUROC",
  primaryEndpointDetails: "AUROC measured on held-out site-local validation cohorts.",
  analysisPlan: "Compare aggregate AUROC and calibration summaries across sites after federated training.",
  dataHandlingPlan: "Participant-level data remains local to each site; only aggregate outputs and logs are shared.",
  intendedUse: "Research validation"
};

describe("governance gates", () => {
  it("requires core study protocol fields before activation", () => {
    expect(missingProtocolFields({ title: "Only title" })).toContain("goal");
  });

  it("requires Health AI core fields before activation", () => {
    expect(missingProtocolFields({ ...completeProtocol, analysisPlan: "" })).toContain("analysisPlan");
    expect(missingProtocolFields({ ...completeProtocol, dataHandlingPlan: null })).toContain("dataHandlingPlan");
  });

  it("does not require optional best-practice fields before activation", () => {
    const gate = activationGate({
      ...completeProtocol,
      hypothesis: "",
      secondaryObjectives: "",
      secondaryOutcomes: "",
      sampleSizeRationale: "",
      humanAiWorkflow: "",
      fairnessPlan: "",
      disseminationPlan: "",
      ethics: [{ status: "APPROVED" }],
      studySites: [{ id: "site-1" }]
    });

    expect(gate.allowed).toBe(true);
  });

  it("allows activation only after study design, site, and ethics clearance", () => {
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
