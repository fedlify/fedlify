import { describe, expect, it } from "vitest";
import { activationGate, ethicsCleared, ethicsExpiredMessage, missingProtocolFields, pipelineExecutionGate } from "@/lib/governance";

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
  it("requires only a title and an objective in the study's own text", () => {
    expect(missingProtocolFields({ title: "Only title" })).toEqual(["goal"]);
    expect(missingProtocolFields({ goal: "Only goal" })).toEqual(["title"]);
    expect(missingProtocolFields({ title: "A title", goal: "<p> </p>" })).toEqual(["goal"]);
    expect(missingProtocolFields({ title: "A title", goal: "<p>Real objective</p>" })).toEqual([]);
  });

  it("does not require the long design fields any more", () => {
    expect(missingProtocolFields({ title: "T", goal: "G", analysisPlan: "", dataHandlingPlan: null })).toEqual([]);
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
    expect(partial.missing).toEqual(["Study questions (2 of 29 answered)"]);

    const complete = activationGate({
      ...completeProtocol,
      ethics: [{ status: "APPROVED" }],
      studySites: [{ id: "site-1" }],
      requirementResponses: Array.from({ length: 29 }, (_, index) => ({ requirementId: `R${String(index + 1).padStart(2, "0")}` }))
    });
    expect(complete.allowed).toBe(true);
  });

  it("lists what is missing in plain words, never raw keys", () => {
    const gate = activationGate({ title: "", goal: null, ethics: [], studySites: [], questions: { answered: 28 } });
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toEqual(["Study title", "Study objective", "Ethics decision", "At least one site", "Study questions (28 of 29 answered)"]);
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

describe("ethics decision expiry", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("clears an approval with no end date or an end date in the future", () => {
    expect(ethicsCleared("APPROVED", null, now)).toBe(true);
    expect(ethicsCleared("NOT_REQUIRED", "2027-01-01T00:00:00Z", now)).toBe(true);
  });
  it("does not clear an approval whose end date is in the past", () => {
    expect(ethicsCleared("APPROVED", "2026-03-05T00:00:00Z", now)).toBe(false);
    expect(ethicsCleared("NOT_REQUIRED", new Date("2026-11-09T00:00:00Z"), now)).toBe(false);
  });
  it("never clears a status that is not an approval, whatever the date", () => {
    expect(ethicsCleared("PENDING", "2030-01-01T00:00:00Z", now)).toBe(false);
    expect(ethicsCleared(null, null, now)).toBe(false);
  });
  it("words the expiry in plain terms", () => {
    expect(ethicsExpiredMessage("2026-03-05T00:00:00Z")).toBe("The ethics decision expired on 5 March 2026. Record the renewed decision.");
  });
  it("blocks activation and execution with an expired approval", () => {
    const expired = [{ status: "APPROVED" as const, validUntil: new Date(Date.now() - 86_400_000) }];
    expect(activationGate({ ...completeProtocol, ethics: expired, studySites: [{}] }).missing).toContain("Ethics decision");
    const gate = pipelineExecutionGate({
      ethicsStatus: "APPROVED",
      ethicsValidUntil: new Date(Date.now() - 86_400_000),
      pipelineApprovalStatus: "APPROVED",
      pipelineValidationStatus: "PASSED",
      readinessChecks: [{ dependenciesVerified: true, policyAccepted: true }]
    });
    expect(gate.missing).toEqual(["ethicsApproval"]);
  });
});
