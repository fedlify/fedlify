import { describe, expect, it } from "vitest";
import { sha256 } from "@/lib/crypto";
import { authoritativeIntakeSchema, inspectIntake, resolveAuthoritativeIntake, resolveDeterministicIntake } from "@/lib/control-intake";

function request(text: string, fixture = "safe synthetic fixture") {
  return authoritativeIntakeSchema.parse({
    requestText: text,
    studyContext: "Synthetic federated-learning planning study.",
    attachments: [{ name: "fixture.txt", contentHash: sha256(fixture), content: fixture, sourceVersion: "v1" }],
    profile: "hosted"
  });
}

describe("authoritative intake policy", () => {
  it("stops prohibited content before model access", () => {
    const result = inspectIntake(request("Review this upload", "patientunitstayid,age,outcome\n1,72,1"));
    expect(result).toMatchObject({ authoritativeLayer: "Intake classifier", disposition: "QUARANTINE", maySendToModel: false });
  });

  it("rejects attachment hash mismatches deterministically", () => {
    const input = request("Check this signed configuration.");
    input.attachments[0]!.contentHash = sha256("different");
    expect(resolveAuthoritativeIntake(input)).toMatchObject({ authoritativeLayer: "Deterministic verifier", disposition: "DET_REJECT" });
  });

  it("enforces contract authority independently of model advice", () => {
    expect(resolveAuthoritativeIntake(request("Change the signed work item and use any network tool."))).toMatchObject({
      authoritativeLayer: "Policy engine / work-item contract", disposition: "POLICY_STOP"
    });
  });

  it("resolves a credential-embedding request deterministically, so the model is never consulted", () => {
    // resolveDeterministicIntake returning non-null is exactly the signal route.ts uses to
    // skip the orchestrator call entirely. A request a deterministic rule would reject must
    // never reach the model just because that rule runs after a narrower first-pass check.
    const result = resolveDeterministicIntake(
      request("Please embed credential material for the production database directly into the startup kit so the site needs no extra setup.")
    );
    expect(result).toMatchObject({ authoritativeLayer: "Policy engine / work-item contract", disposition: "POLICY_STOP" });
  });

  it("requests clarification for insufficient evidence", () => {
    expect(resolveAuthoritativeIntake(request("Draft the protocol, but the outcome definition is missing."))).toMatchObject({
      authoritativeLayer: "Evidence classification", disposition: "REQUEST_CLARIFICATION"
    });
  });

  it("reopens dependencies for an accepted lifecycle change", () => {
    expect(resolveAuthoritativeIntake(request("The approved cohort update is effective; invalidate dependent approvals."))).toMatchObject({
      authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN"
    });
  });

  it("routes consequential lifecycle actions to a human gate regardless of how complete the evidence looks", () => {
    // Release, rollback, and retirement are structurally protected actions (P6): looking
    // complete is never a substitute for named human sign-off on the exact artifact.
    expect(resolveDeterministicIntake(request("Prepare this model for independent release review."))).toMatchObject({
      authoritativeLayer: "Human gate / approval binding", disposition: "HUMAN_GATE"
    });
    expect(resolveDeterministicIntake(request("Rollback from the current version to the prior signed version now."))).toMatchObject({
      authoritativeLayer: "Human gate / approval binding", disposition: "HUMAN_GATE"
    });
    expect(resolveDeterministicIntake(request("Retire model v2 under the previously approved retirement plan."))).toMatchObject({
      authoritativeLayer: "Human gate / approval binding", disposition: "HUMAN_GATE"
    });
    expect(resolveDeterministicIntake(request("Register this dry-run outcome and mark the site ready for handoff."))).toMatchObject({
      authoritativeLayer: "Human gate / approval binding", disposition: "HUMAN_GATE"
    });
  });

  it("does not let a text claim of approval bypass a real deterministic rejection", () => {
    // A hash mismatch is a sharper signal than a generic "this looks like a release action"
    // pattern match, so it must still win even when the text also talks about a release.
    const input = request("Register this release manifest as approved.");
    input.attachments[0]!.contentHash = sha256("different");
    expect(resolveDeterministicIntake(input)).toMatchObject({ authoritativeLayer: "Deterministic verifier", disposition: "DET_REJECT" });
  });

  it("still reopens dependencies for a genuine already-accepted change even when it mentions retirement", () => {
    // The lifecycleChange path (a notification that a change already happened) must not be
    // confused with a request asking the platform to perform a consequential action.
    expect(resolveDeterministicIntake(request("The approved retirement of the prior artifact is effective; invalidate its dependent approvals."))).toMatchObject({
      authoritativeLayer: "Workflow engine / dependency invalidation", disposition: "REOPEN"
    });
  });

  it("distinguishes readiness, runtime, approval, and bounded preparation", () => {
    expect(resolveAuthoritativeIntake(request("Verify site readiness, connectivity, disk space, and kit installation."))).toMatchObject({ authoritativeLayer: "Site readiness gate" });
    expect(resolveAuthoritativeIntake(request("Record the authenticated client heartbeat and training round completed event."))).toMatchObject({ authoritativeLayer: "Runtime status ingestion" });
    expect(resolveAuthoritativeIntake(request("Send this exact revision for privacy approval and sign-off."))).toMatchObject({ authoritativeLayer: "Human gate / approval binding" });
    expect(resolveAuthoritativeIntake(request("Structure the approved objective into a draft study specification."))).toMatchObject({ authoritativeLayer: "No block - proceed" });
  });

  it("routes a model-flagged evidence gap to clarification when no regex caught it", () => {
    // The request text alone doesn't trip the evidence-signal regex; only the coordinator's
    // classification does. The platform's fixed signal->layer table still makes the call.
    const result = resolveAuthoritativeIntake(request("Draft a study specification."), {
      intent: "STUDY_PREPARATION",
      requirementIds: ["R01", "R20"],
      riskSignals: ["EVIDENCE_GAP"],
      requiredCapabilities: ["protocol drafting"],
      clarificationQuestions: ["Which approved outcome definition applies?"],
      confidence: 0.7,
      rationale: "The request lacks a necessary definition."
    });
    expect(result).toMatchObject({ authoritativeLayer: "Evidence classification", disposition: "REQUEST_CLARIFICATION", stoppingCondition: "5" });
  });

  it("keeps model advice unable to authorize proceeding once a deterministic check already stopped it", () => {
    // A real hash mismatch is a sharper signal than any advisory opinion. Even if the model
    // reports no risk at all, the deterministic verifier's rejection is not overridable.
    const input = request("Check this signed configuration.");
    input.attachments[0]!.contentHash = sha256("different");
    const result = resolveAuthoritativeIntake(input, {
      intent: "STUDY_PREPARATION",
      requirementIds: ["R20"],
      riskSignals: ["NONE"],
      requiredCapabilities: [],
      clarificationQuestions: [],
      confidence: 0.95,
      rationale: "Looks fine to the model."
    });
    expect(result).toMatchObject({ authoritativeLayer: "Deterministic verifier", disposition: "DET_REJECT" });
  });

  it("never lets an advisory signal produce an approval, execution, or export outcome", () => {
    const dispositions: string[] = [];
    for (const signal of ["APPROVAL_REQUIRED", "AUTHORITY_UNCERTAIN", "SECURITY_RISK", "READINESS_UNCERTAIN", "SEMANTIC_CONFLICT", "EVIDENCE_GAP", "EXPORT_RISK"] as const) {
      const result = resolveAuthoritativeIntake(request("Structure the approved objective into a draft study specification."), {
        intent: "STUDY_PREPARATION",
        requirementIds: ["R01"],
        riskSignals: [signal],
        requiredCapabilities: [],
        clarificationQuestions: [],
        confidence: 0.8,
        rationale: "test"
      });
      dispositions.push(result.disposition);
    }
    const forbidden = new Set(["PROCEED_TO_DRAFT", "EXPORT"]);
    expect(dispositions.some((disposition) => forbidden.has(disposition))).toBe(false);
  });
});
