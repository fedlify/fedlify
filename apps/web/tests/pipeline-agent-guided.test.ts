import { describe, expect, it } from "vitest";
import {
  buildGuidedIntakeMessage,
  closePipelineAgentTab,
  derivePipelineAgentLayoutMode,
  GUIDED_QUESTIONS,
  nextGuidedMissingField
} from "@/lib/pipeline-agent-guided";
import { applyTemplateAgentIntakePatch, missingTemplateAgentFields } from "@/lib/template-agent";

describe("pipeline agent guided intake config", () => {
  it("maps every backend missing label to a guided question config", () => {
    const requiredLabels = missingTemplateAgentFields({});
    expect(requiredLabels.length).toBeGreaterThan(0);
    for (const label of requiredLabels) {
      expect(GUIDED_QUESTIONS[label], `Missing guided config for ${label}`).toBeDefined();
    }
  });

  it("provides three curated options for every required field", () => {
    for (const label of missingTemplateAgentFields({})) {
      expect(GUIDED_QUESTIONS[label].curatedOptions).toHaveLength(3);
    }
  });

  it("keeps the custom fallback enabled for every guided field", () => {
    for (const label of missingTemplateAgentFields({})) {
      expect(GUIDED_QUESTIONS[label].allowCustom).toBe(true);
    }
  });

  it("builds deterministic single-field intake messages", () => {
    expect(buildGuidedIntakeMessage("aggregation behavior", "weighted FedAvg")).toBe("Set aggregation behavior to weighted FedAvg.");
    expect(buildGuidedIntakeMessage("minimum clients", 3)).toBe("Set minimum clients to 3.");
    expect(buildGuidedIntakeMessage("data modalities", ["tabular", "imaging"])).toBe("Set the data modalities to tabular, imaging.");
  });

  it("advances to the next unresolved guided field after completion", () => {
    const missing = ["template name", "what the template should do", "template purpose"];
    expect(nextGuidedMissingField(missing, [])).toBe("template name");
    expect(nextGuidedMissingField(missing, ["template name"])).toBe("what the template should do");
    expect(nextGuidedMissingField(["template purpose"], ["template name", "what the template should do"])).toBe("template purpose");
  });

  it("merges intake patches and keeps unresolved fields without model work", () => {
    const result = applyTemplateAgentIntakePatch(
      {
        templateName: "icu-heart-failure",
        purpose: "training"
      },
      {
        aggregation: "weighted FedAvg",
        minClients: 2
      }
    );
    expect(result.intake.templateName).toBe("icu-heart-failure");
    expect(result.intake.aggregation).toBe("weighted FedAvg");
    expect(result.intake.minClients).toBe(2);
    expect(result.missing).toContain("what the template should do");
    expect(result.status).toBe("INTAKE");
  });

  it("switches intake status to coding when the last required field is answered", () => {
    const result = applyTemplateAgentIntakePatch(
      {},
      {
        templateName: "icu-heart-failure",
        agentRequest: "Build a federated mortality prediction workflow for ICU heart failure patients.",
        purpose: "training",
        clinicalUseCase: "risk-prediction",
        clinicalApplication: "prognosis",
        diseaseCategory: "critical care",
        collaborationSetting: "cross-silo hospitals",
        dataDistribution: "horizontal: different patients/same features",
        dataModalities: ["tabular"],
        outcomeDefinition: "Binary mortality label generated locally at each site.",
        participatingSites: "Two hospital sites participate as training clients.",
        governanceContact: "Study PI and institutional privacy officer.",
        siteLocalInputs: "Each site provides ICU tabular features and binary mortality labels.",
        dataReadinessSummary: "Each site can provide aggregate counts, schema summary, label availability, and missingness summary.",
        siteConstraints: "Outbound-only networking and human release approval are required.",
        systemTopology: "centralized aggregation",
        privacySecurityPlan: "Secure aggregation where supported, signed artifacts, no raw-data paths, and human release review.",
        trainingStrategy: "synchronous",
        challengeProfile: "Non-IID data, small site cohorts, limited compute, and fairness risk require validation.",
        syntheticFixtures: "Synthetic numpy arrays only for smoke tests.",
        nvflareWorkflow: "cross_silo",
        minClients: 2,
        numRounds: 5,
        aggregation: "weighted FedAvg",
        artifactOutputs: "server.npy, metrics.json, README",
        dependencyPolicy: "Use scikit-learn and numpy only.",
        privacyConstraints: "No raw clinical data leaves any site.",
        approvalStatus: "approved-for-template-development",
        reviewExpectations: "Validate README, manifest, and executor imports."
      }
    );
    expect(result.missing).toEqual([]);
    expect(result.status).toBe("CODING");
  });
});

describe("pipeline agent layout behavior", () => {
  it("starts in chat-focus with no open file", () => {
    expect(derivePipelineAgentLayoutMode({ explorerOpen: false, openTabs: [] })).toBe("chat-focus");
  });

  it("switches to editing when a file is opened", () => {
    expect(derivePipelineAgentLayoutMode({ explorerOpen: false, openTabs: ["nvflare-job/app/custom/executor.py"] })).toBe("editing");
  });

  it("returns to chat-focus when the last tab closes", () => {
    const result = closePipelineAgentTab({
      openTabs: ["README.md"],
      selectedPath: "README.md",
      path: "README.md"
    });
    expect(result.openTabs).toEqual([]);
    expect(result.selectedPath).toBeNull();
    expect(result.explorerOpen).toBe(false);
    expect(result.workspaceOpen).toBe(false);
    expect(result.layoutMode).toBe("chat-focus");
  });
});
