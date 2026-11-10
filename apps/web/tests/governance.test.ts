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

  it("requires all 29 requirement answers before activation when responses are supplied", () => {
    const partial = activationGate({
      ...completeProtocol,
      ethics: [{ status: "APPROVED" }],
      studySites: [{ id: "site-1" }],
      requirementResponses: [{ requirementId: "R01" }, { requirementId: "R02" }]
    });
    expect(partial.allowed).toBe(false);
    expect(partial.missing).toEqual(["requirements (2/29 answered)"]);

    const complete = activationGate({
      ...completeProtocol,
      ethics: [{ status: "APPROVED" }],
      studySites: [{ id: "site-1" }],
      requirementResponses: Array.from({ length: 29 }, (_, index) => ({ requirementId: `R${String(index + 1).padStart(2, "0")}` }))
    });
    expect(complete.allowed).toBe(true);
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
      readinessChecks: [{ dependenciesVerified: true, policyAccepted: false }]
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
        readinessChecks: [{ dependenciesVerified: true, policyAccepted: true }]
      }).allowed
    ).toBe(true);
  });
});

import { describeUnreadySites, executionGateMessage } from "@/lib/governance";

describe("execution gate message", () => {
  const sites = [
    { code: "A", name: "Site A", check: { dependenciesVerified: true, policyAccepted: true } },
    { code: "B", name: "Site B", check: { dependenciesVerified: true, policyAccepted: false } },
    { code: "C", name: "Site C", check: null }
  ];

  it("lists only unready sites with what is open", () => {
    const unready = describeUnreadySites(sites);
    expect(unready.map((s) => s.code)).toEqual(["B", "C"]);
    expect(unready[0].problems).toEqual(["data-use policy not accepted"]);
    expect(unready[1].problems).toEqual(["no site sign-off has been recorded"]);
  });

  it("names the sites and the fix in the message", () => {
    const message = executionGateMessage(["allSitesReady"], describeUnreadySites(sites));
    expect(message).toContain("Site B:");
    expect(message).toContain("Site C:");
    expect(message).not.toContain("Site A");
    expect(message).toMatch(/site sign-off/);
    expect(message).not.toMatch(/connectivity|kit|attestation|aggregator/i);
    expect(message).not.toContain("allSitesReady");
  });

  it("explains other missing requirements in words", () => {
    const message = executionGateMessage(["ethicsApproval", "approvedPipelineVersion"]);
    expect(message).toMatch(/ethics decision/);
    expect(message).toMatch(/pipeline version is not approved/);
    expect(message).not.toMatch(/ethicsApproval|approvedPipelineVersion/);
  });

  it("never shows raw requirement keys", () => {
    const message = executionGateMessage(
      ["ethicsApproval", "approvedPipelineVersion", "passedPipelineValidation", "readySites", "allSitesReady"],
      describeUnreadySites(sites)
    );
    expect(message).not.toMatch(/ethicsApproval|approvedPipelineVersion|passedPipelineValidation|readySites|allSitesReady|attestation|aggregator|participat/i);
  });
});

import { publishRequirementMessage } from "@/lib/governance";

describe("publish requirement messages", () => {
  it("are plain sentences without raw keys", () => {
    expect(publishRequirementMessage("ethicsApproval")).toBe("Record the ethics decision");
    expect(publishRequirementMessage("studySites")).toBe("Add at least one site");
    expect(publishRequirementMessage("studyQuestions", { remaining: 3 })).toBe("Answer the remaining study questions (3 left)");
  });
});
