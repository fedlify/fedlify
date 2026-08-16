import { describe, expect, it } from "vitest";
import {
  buildFedlifyAgentSkillContext,
  detectAgentGuardrailFindings,
  evaluateFedlifyAgentSkills,
  FEDLIFY_AGENT_RUNTIME_CONTRACT,
  FEDLIFY_AGENT_SKILLS,
  routeNextFedlifyAgentSkill
} from "@/lib/fedlify-agent-skills";
import type { TemplateAgentIntake } from "@/lib/template-agent";

const completeIntake: TemplateAgentIntake = {
  templateName: "fedavg-tabular-risk-prediction",
  agentRequest: "Build a federated supervised training workflow for readmission risk.",
  purpose: "training",
  clinicalUseCase: "risk-prediction",
  clinicalApplication: "prognosis",
  diseaseCategory: "critical care",
  collaborationSetting: "cross-silo hospitals",
  dataDistribution: "horizontal: different patients/same features",
  dataModalities: ["tabular"],
  outcomeDefinition: "Binary readmission risk label generated locally at each site.",
  participatingSites: "Two hospital sites participate as training clients.",
  governanceContact: "Study PI and institutional privacy officer.",
  siteLocalInputs: "Each site maps local tabular features into the approved schema.",
  dataReadinessSummary: "Sites can provide aggregate counts, schema summary, label availability, and missingness summary.",
  siteConstraints: "Outbound-only networking, local container review, and human release approval.",
  systemTopology: "centralized aggregation",
  privacySecurityPlan: "Secure aggregation where supported, signed artifacts, no raw-data paths, and release review.",
  trainingStrategy: "synchronous",
  challengeProfile: "Non-IID data, small site cohorts, limited compute, and fairness risk require validation.",
  syntheticFixtures: "Synthetic numpy arrays only for smoke tests.",
  nvflareWorkflow: "cross_silo",
  minClients: 2,
  numRounds: 5,
  aggregation: "weighted FedAvg",
  artifactOutputs: "server.npy, aggregate metrics, README, manifest",
  dependencyPolicy: "Use scikit-learn and numpy only.",
  privacyConstraints: "Raw clinical data remains site-local. No patient files in Git.",
  approvalStatus: "approved-for-template-development",
  reviewExpectations: "README, manifest, config consistency, imports, and no raw-data paths must pass."
};

describe("Fedlify agent skill cards", () => {
  it("defines concrete runtime skill cards", () => {
    expect(FEDLIFY_AGENT_SKILLS).toHaveLength(7);
    expect(FEDLIFY_AGENT_RUNTIME_CONTRACT).toContain("human_approval_gate");
    for (const skill of FEDLIFY_AGENT_SKILLS) {
      expect(skill.trigger.length).toBeGreaterThan(10);
      expect(skill.requiredInputs.length).toBeGreaterThan(0);
      expect(skill.instruction.length).toBeGreaterThan(20);
      expect(skill.outputs.length).toBeGreaterThan(0);
      expect(skill.validationChecks.length).toBeGreaterThan(0);
      expect(skill.guardrails.length).toBeGreaterThan(0);
      expect(skill.evidenceBasis.length).toBeGreaterThan(0);
    }
  });

  it("defines evidence-backed aspect cards for the minimum health-FL taxonomy", () => {
    const context = buildFedlifyAgentSkillContext(completeIntake);
    expect(context.aspects.map((aspect) => aspect.id)).toEqual([
      "collaboration_setting",
      "data_distribution",
      "data_modality",
      "system_topology",
      "privacy_security",
      "training_strategy",
      "clinical_application",
      "disease_category",
      "challenge_profile"
    ]);
    expect(context.aspects.every((aspect) => aspect.sampleQuestions.length > 0)).toBe(true);
    expect(context.evidence.map((paper) => paper.key)).toContain("kairouz2021openproblems");
    expect(context.evidence.map((paper) => paper.key)).toContain("yang2019fml");
    expect(context.evidence.map((paper) => paper.key)).toContain("rieke2020digitalhealth");
  });

  it("routes incomplete intake to the first blocked skill", () => {
    const nextSkill = routeNextFedlifyAgentSkill({ clinicalUseCase: "risk-prediction" });
    expect(nextSkill.id).toBe("study_intake_eligibility");
    expect(nextSkill.status).toBe("WAITING_FOR_INPUT");
    expect(nextSkill.missingInputs).toContain("study goal");
  });

  it("marks all skills ready when governed intake is complete", () => {
    const states = evaluateFedlifyAgentSkills(completeIntake);
    expect(states.every((state) => state.status === "READY")).toBe(true);
  });

  it("blocks intake that includes restricted identifiers, secrets, or raw data paths", () => {
    const findings = detectAgentGuardrailFindings({
      ...completeIntake,
      siteLocalInputs: "Load records from /data/patients/site-a.csv",
      governanceContact: "Use api_key=abc123 for access."
    });

    expect(findings.length).toBeGreaterThanOrEqual(2);
    const states = evaluateFedlifyAgentSkills({
      ...completeIntake,
      siteLocalInputs: "Load records from /data/patients/site-a.csv"
    });
    expect(states.some((state) => state.status === "BLOCKED_BY_GUARDRAIL")).toBe(true);
  });

  it("serializes skill context for prompts and manifests", () => {
    const context = buildFedlifyAgentSkillContext(completeIntake);
    expect(context.runtimeContract).toContain("output_schema");
    expect(context.nextSkill.status).toBe("READY");
    expect(context.skills.map((skill) => skill.id)).toContain("template_bound_code_generation");
  });
});
