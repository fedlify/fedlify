import { describe, expect, it } from "vitest";
import {
  nextTemplateVersion,
  templateKeyForName,
  templateRepoName,
  validateTemplateIntake,
  validateTemplateRepositoryFiles,
  type TemplateIntakeAnswers
} from "@/lib/pipeline-template-code";
import type { PipelineFile } from "@/lib/pipeline-code";

const completeIntake: TemplateIntakeAnswers = {
  purpose: "training",
  clinicalUseCase: "Risk prediction",
  dataModalities: ["EHR", "Labs"],
  siteLocalInputs: "Each site maps local tabular features into the expected synthetic fixture schema.",
  syntheticFixtures: "Synthetic CSV-like fixtures are generated in tests only.",
  nvflareWorkflow: "cross-silo FedAvg",
  minClients: 2,
  numRounds: 5,
  aggregation: "FedAvg weighted by site sample count.",
  privacyConstraints: "No raw records, identifiers, or clinical extracts may be committed.",
  dependencyPolicy: "Use pinned Python dependencies already allowed by the platform runtime.",
  artifactOutputs: "workspace/models/server.npy, metrics.json, log.txt",
  reviewExpectations: "README, manifest, syntax checks, and NVFLARE job shape must pass."
};

function validTemplateFiles(overrides: PipelineFile[] = []): PipelineFile[] {
  const files = [
    { path: "README.md", content: "# Sepsis risk template\n" },
    {
      path: "AGENTS.md",
      content:
        "Ask for missing clinical use case, modality, privacy, runtime, and artifact requirements before changing code."
    },
    {
      path: ".fedlify/template.json",
      content: JSON.stringify({
        packageType: "fedlify-nvflare-template",
        dataBoundary: "site-only",
        runtimeDefaults: { minClients: 2, numRounds: 5 }
      })
    },
    { path: "nvflare-job/meta.conf", content: "name = \"sepsis-template\"\n" },
    { path: "nvflare-job/app/config/config_fed_server.conf", content: "min_clients = 2\n" },
    { path: "nvflare-job/app/config/config_fed_client.conf", content: "executor = \"fedlify\"\n" }
  ];
  for (const override of overrides) {
    const index = files.findIndex((file) => file.path === override.path);
    if (index >= 0) files[index] = override;
    else files.push(override);
  }
  return files;
}

describe("pipeline template catalog helpers", () => {
  it("derives stable Gitea repo and template keys", () => {
    expect(templateRepoName("Sepsis Risk Prediction")).toBe("template-sepsis-risk-prediction");
    expect(templateRepoName("Sepsis Risk Prediction", "fedlify-template")).toBe("fedlify-template-sepsis-risk-prediction");
    expect(templateKeyForName("MRI + Labs Template")).toBe("mri-labs-template");
  });

  it("blocks incomplete structured intake before a proposal can be created", () => {
    expect(validateTemplateIntake(completeIntake)).toEqual([]);

    const errors = validateTemplateIntake({
      ...completeIntake,
      dataModalities: [],
      minClients: 0,
      privacyConstraints: ""
    });

    expect(errors).toContain("Missing or invalid template intake field: dataModalities");
    expect(errors).toContain("Missing or invalid template intake field: minClients");
    expect(errors).toContain("Missing or invalid template intake field: privacyConstraints");
  });

  it("validates required source-backed template repository shape", () => {
    expect(validateTemplateRepositoryFiles(validTemplateFiles()).status).toBe("PASSED");

    const validation = validateTemplateRepositoryFiles(validTemplateFiles([{ path: "fixtures/raw-data.csv", content: "id,value\n1,2\n" }]));

    expect(validation.status).toBe("FAILED");
    expect(validation.summary).toContain("prohibited data-like path");
  });

  it("requires a Fedlify template manifest with site-local data boundary", () => {
    const validation = validateTemplateRepositoryFiles(
      validTemplateFiles([
        {
          path: ".fedlify/template.json",
          content: JSON.stringify({ packageType: "other", dataBoundary: "centralized", runtimeDefaults: { minClients: 0 } })
        }
      ])
    );

    expect(validation.status).toBe("FAILED");
    expect(validation.errors).toContain("Template manifest packageType must be fedlify-nvflare-template.");
    expect(validation.errors).toContain("Template manifest dataBoundary must be site-only.");
    expect(validation.errors).toContain("Template manifest runtimeDefaults.minClients must be at least 1.");
  });

  it("generates immutable template catalog versions predictably", () => {
    expect(nextTemplateVersion(0)).toBe("v1.0.0");
    expect(nextTemplateVersion(2)).toBe("v3.0.0");
  });
});
