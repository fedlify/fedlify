import type { PipelineTemplate } from "@prisma/client";
import { buildFedlifyAgentSkillContext, fedlifyAgentSkillsMarkdown } from "@/lib/fedlify-agent-skills";
import { buildNvflareJobPipelineFiles, type PipelineFile } from "@/lib/pipeline-code";
import { slugify } from "@/lib/slug";
import type { TemplateAgentIntake } from "@/lib/template-agent";

export type TemplateIntakeAnswers = {
  purpose: string;
  clinicalUseCase: string;
  dataModalities: string[];
  siteLocalInputs: string;
  syntheticFixtures: string;
  nvflareWorkflow: string;
  minClients: number;
  numRounds: number;
  aggregation: string;
  privacyConstraints: string;
  dependencyPolicy: string;
  artifactOutputs: string;
  reviewExpectations: string;
  collaborationSetting?: string;
  dataDistribution?: string;
  systemTopology?: string;
  privacySecurityPlan?: string;
  trainingStrategy?: string;
  clinicalApplication?: string;
  diseaseCategory?: string;
  challengeProfile?: string;
  outcomeDefinition?: string;
  participatingSites?: string;
  governanceContact?: string;
  dataReadinessSummary?: string;
  siteConstraints?: string;
  approvalStatus?: string;
};

export function templateRepoName(name: string, prefix = "template"): string {
  return `${prefix}-${slugify(name).slice(0, 60)}`;
}

export function templateKeyForName(name: string): string {
  return slugify(name).slice(0, 80);
}

export function validateTemplateIntake(value: Partial<TemplateIntakeAnswers>): string[] {
  const requiredText: Array<keyof TemplateIntakeAnswers> = [
    "purpose",
    "clinicalUseCase",
    "siteLocalInputs",
    "syntheticFixtures",
    "nvflareWorkflow",
    "aggregation",
    "privacyConstraints",
    "dependencyPolicy",
    "artifactOutputs",
    "reviewExpectations"
  ];
  const missing = requiredText.filter((key) => typeof value[key] !== "string" || String(value[key]).trim().length < 3);
  if (!Array.isArray(value.dataModalities) || value.dataModalities.length === 0) missing.push("dataModalities");
  if (!Number.isInteger(value.minClients) || Number(value.minClients) < 1) missing.push("minClients");
  if (!Number.isInteger(value.numRounds) || Number(value.numRounds) < 1) missing.push("numRounds");
  return missing.map((field) => `Missing or invalid template intake field: ${field}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(", ");
  return fallback;
}

function stringArrayValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const values = value.map(String).filter((item) => item.trim());
    if (values.length > 0) return values;
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

function positiveIntegerValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function templateSpecToTemplateIntake(spec: unknown): TemplateIntakeAnswers {
  const record = asRecord(spec);
  const runtimeDefaults = asRecord(record.runtimeDefaults);

  return {
    purpose: stringValue(record.purpose ?? record.jobType, "training"),
    clinicalUseCase: stringValue(record.clinicalUseCase, "Health AI federated learning"),
    dataModalities: stringArrayValue(record.dataModalities, ["Site-described tabular features"]),
    siteLocalInputs: stringValue(record.siteLocalInputs, "Each site maps local tabular features into the expected template schema."),
    syntheticFixtures: stringValue(record.syntheticFixtures, "Synthetic fixtures are generated for smoke tests only."),
    nvflareWorkflow: stringValue(record.workflow ?? record.nvflareWorkflow, "scatter_and_gather"),
    minClients: positiveIntegerValue(runtimeDefaults.minClients, 2),
    numRounds: positiveIntegerValue(runtimeDefaults.numRounds, 5),
    aggregation: stringValue(record.aggregation ?? runtimeDefaults.aggregation, "weighted FedAvg"),
    privacyConstraints: stringValue(record.privacyConstraints ?? record.privacy, "Raw clinical data remains site-local. No patient files in Git."),
    dependencyPolicy: stringValue(record.dependencyPolicy, "Use standard NVFLARE and scikit-learn only."),
    artifactOutputs: stringValue(record.artifactOutputs, "server.npy, metrics summary, logs, manifest"),
    reviewExpectations: stringValue(record.reviewExpectations, "README, manifest, NVFLARE job shape, and no raw-data paths must pass."),
    collaborationSetting: stringValue(record.collaborationSetting, "Cross-silo hospitals or research sites with stable organizational participants."),
    dataDistribution: stringValue(record.dataDistribution, "Horizontal FL unless sites explicitly report vertical or partial-overlap data."),
    systemTopology: stringValue(record.systemTopology, "Centralized aggregation through a named coordinating organization."),
    privacySecurityPlan: stringValue(record.privacySecurityPlan, "Signed artifacts, no raw-data paths, site-local execution, and human release review."),
    trainingStrategy: stringValue(record.trainingStrategy, "Synchronous FedAvg unless site availability or heterogeneity requires another strategy."),
    clinicalApplication: stringValue(record.clinicalApplication, "Clinical research"),
    diseaseCategory: stringValue(record.diseaseCategory, "Other"),
    challengeProfile: stringValue(record.challengeProfile, "Assess non-IID data, small site sample sizes, compute/network limits, reproducibility, fairness, and governance blockers."),
    outcomeDefinition: stringValue(record.outcomeDefinition, "Site-defined supervised label or endpoint documented during study intake."),
    participatingSites: stringValue(record.participatingSites, "Participating sites are named during governed Fedlify intake."),
    governanceContact: stringValue(record.governanceContact, "Named study governance contact required before workflow freeze."),
    dataReadinessSummary: stringValue(record.dataReadinessSummary, "Each site provides aggregate counts, schema notes, label availability, and missingness summary before code generation."),
    siteConstraints: stringValue(record.siteConstraints, "Site runtime, networking, data-use, and approval constraints are recorded before kit generation."),
    approvalStatus: stringValue(record.approvalStatus, "Draft or pending approval; production execution requires human approval.")
  };
}

function agentsMarkdown() {
  return [
    "# Fedlify NVFLARE Template Agent Instructions",
    "",
    "You are editing a reusable health-AI federated learning template for Fedlify.",
    "",
    "Rules:",
    "- Keep raw patient-level data, identifiers, extracts, CSV, and parquet files out of this repository.",
    "- Preserve a runnable `nvflare-job/` folder and keep site execution local.",
    "- Ask for missing clinical use case, modality, site input, privacy, dependency, runtime, or artifact requirements before changing code.",
    "- Use synthetic fixtures only for tests and smoke validation.",
    "- Do not approve, merge, publish, or run production NVFLARE jobs.",
    "- Keep runtime parameters configurable by Fedlify at job submission time.",
    "",
    "# Agentic skill cards",
    "",
    "Fedlify agents operate through bounded skill cards instead of unrestricted chat prompts.",
    "Each card has a trigger, required inputs, task instruction, allowed tools, output schema, validation tests, stop conditions, human approval gate, and evidence basis.",
    "",
    fedlifyAgentSkillsMarkdown(),
    ""
  ].join("\n");
}

function templateManifest(input: {
  name: string;
  templateKey: string;
  description?: string | null;
  intake: TemplateIntakeAnswers;
}) {
  return {
    packageType: "fedlify-nvflare-template",
    version: "1.0.0",
    name: input.name,
    templateKey: input.templateKey,
    description: input.description ?? null,
    framework: "nvflare",
    purpose: input.intake.purpose,
    clinicalUseCase: input.intake.clinicalUseCase,
    dataModalities: input.intake.dataModalities,
    workflow: input.intake.nvflareWorkflow,
    runtimeDefaults: {
      minClients: input.intake.minClients,
      numRounds: input.intake.numRounds,
      aggregation: input.intake.aggregation
    },
    dataBoundary: "site-only",
    siteLocalInputs: input.intake.siteLocalInputs,
    syntheticFixtures: input.intake.syntheticFixtures,
    privacyConstraints: input.intake.privacyConstraints,
    dependencyPolicy: input.intake.dependencyPolicy,
    artifactOutputs: input.intake.artifactOutputs,
    reviewExpectations: input.intake.reviewExpectations,
    collaborationSetting: input.intake.collaborationSetting ?? null,
    dataDistribution: input.intake.dataDistribution ?? null,
    systemTopology: input.intake.systemTopology ?? null,
    privacySecurityPlan: input.intake.privacySecurityPlan ?? null,
    trainingStrategy: input.intake.trainingStrategy ?? null,
    clinicalApplication: input.intake.clinicalApplication ?? null,
    diseaseCategory: input.intake.diseaseCategory ?? null,
    challengeProfile: input.intake.challengeProfile ?? null,
    outcomeDefinition: input.intake.outcomeDefinition ?? null,
    participatingSites: input.intake.participatingSites ?? null,
    governanceContact: input.intake.governanceContact ?? null,
    dataReadinessSummary: input.intake.dataReadinessSummary ?? null,
    siteConstraints: input.intake.siteConstraints ?? null,
    approvalStatus: input.intake.approvalStatus ?? null,
    agenticWorkflow: buildFedlifyAgentSkillContext(input.intake as TemplateAgentIntake)
  };
}

export async function buildTemplateRepositoryFiles(input: {
  name: string;
  templateKey: string;
  description?: string | null;
  prompt: string;
  intake: TemplateIntakeAnswers;
  useAi?: boolean;
}): Promise<PipelineFile[]> {
  const runtimeFiles = await buildNvflareJobPipelineFiles({
    study: {
      id: "template-study",
      title: input.name,
      slug: input.templateKey,
      goal: input.description ?? input.prompt,
      researchQuestion: input.prompt,
      clinicalUseCase: input.intake.clinicalUseCase,
      dataModalities: input.intake.dataModalities.join(","),
      intendedUse: "RESEARCH_ONLY"
    } as never,
    template: {
      name: input.name,
      templateKey: input.templateKey,
      framework: "nvflare",
      version: "1.0.0",
      spec: templateManifest(input)
    } as Pick<PipelineTemplate, "name" | "templateKey" | "framework" | "version" | "spec">,
    projectName: input.name,
    prompt: input.prompt,
    useAi: input.useAi,
    sites: [
      {
        id: "template-site",
        code: "site-template",
        name: "Template Site",
        institutionName: "Template Institution",
        site: { nvflareClientName: "site_template" }
      }
    ] as never
  });
  const nvflareFiles = runtimeFiles.filter((file) => file.path.startsWith("nvflare-job/"));
  return [
    {
      path: "README.md",
      content: [
        `# ${input.name}`,
        "",
        input.description ?? "Reusable Fedlify NVFLARE template.",
        "",
        "This repository contains a reusable NVFLARE job template for Fedlify-governed health-AI federated learning.",
        "Raw clinical data must remain at participant sites.",
        "",
        "## Runtime defaults",
        `- Workflow: ${input.intake.nvflareWorkflow}`,
        `- Minimum clients: ${input.intake.minClients}`,
        `- Federated rounds: ${input.intake.numRounds}`,
        `- Aggregation: ${input.intake.aggregation}`,
        `- Collaboration setting: ${input.intake.collaborationSetting ?? "Documented during study intake"}`,
        `- Data distribution: ${input.intake.dataDistribution ?? "Documented during study intake"}`,
        `- System topology: ${input.intake.systemTopology ?? "Documented during study intake"}`,
        `- Training strategy: ${input.intake.trainingStrategy ?? "Documented during study intake"}`,
        `- Clinical application: ${input.intake.clinicalApplication ?? "Documented during study intake"}`,
        `- Disease category: ${input.intake.diseaseCategory ?? "Documented during study intake"}`,
        `- Outcome/label: ${input.intake.outcomeDefinition ?? "Documented during study intake"}`,
        `- Participating sites: ${input.intake.participatingSites ?? "Documented during study intake"}`,
        `- Approval status: ${input.intake.approvalStatus ?? "Draft"}`,
        "",
        "## Review checklist",
        input.intake.reviewExpectations,
        ""
      ].join("\n")
    },
    { path: "AGENTS.md", content: agentsMarkdown() },
    { path: ".fedlify/template.json", content: JSON.stringify(templateManifest(input), null, 2) },
    {
      path: "tests/test_template_manifest.py",
      content: [
        "import json",
        "from pathlib import Path",
        "",
        "",
        "def test_template_manifest_keeps_data_site_local():",
        "    manifest = json.loads(Path('.fedlify/template.json').read_text())",
        "    assert manifest['packageType'] == 'fedlify-nvflare-template'",
        "    assert manifest['dataBoundary'] == 'site-only'",
        "    assert manifest['runtimeDefaults']['minClients'] >= 1",
        ""
      ].join("\n")
    },
    ...nvflareFiles
  ];
}

export function validateTemplateRepositoryFiles(files: PipelineFile[]) {
  const paths = new Set(files.map((file) => file.path));
  const required = [
    "README.md",
    "AGENTS.md",
    ".fedlify/template.json",
    "nvflare-job/meta.conf",
    "nvflare-job/app/config/config_fed_server.conf",
    "nvflare-job/app/config/config_fed_client.conf"
  ];
  const errors = required.filter((path) => !paths.has(path)).map((path) => `Missing required template file: ${path}`);
  const prohibitedPathPatterns = [/patient/i, /patients/i, /clinical[-_ ]?extract/i, /raw[-_ ]?data/i, /\.csv$/i, /\.parquet$/i];
  for (const file of files) {
    if (prohibitedPathPatterns.some((pattern) => pattern.test(file.path))) {
      errors.push(`Template repository contains a prohibited data-like path: ${file.path}`);
    }
  }
  const manifest = files.find((file) => file.path === ".fedlify/template.json")?.content;
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { packageType?: string; dataBoundary?: string; runtimeDefaults?: { minClients?: number } };
      if (parsed.packageType !== "fedlify-nvflare-template") errors.push("Template manifest packageType must be fedlify-nvflare-template.");
      if (parsed.dataBoundary !== "site-only") errors.push("Template manifest dataBoundary must be site-only.");
      if (!parsed.runtimeDefaults || Number(parsed.runtimeDefaults.minClients) < 1) {
        errors.push("Template manifest runtimeDefaults.minClients must be at least 1.");
      }
    } catch {
      errors.push("Template manifest is not valid JSON.");
    }
  }
  return {
    status: errors.length === 0 ? "PASSED" : "FAILED",
    errors,
    summary:
      errors.length === 0
        ? "Template repository shape, manifest, NVFLARE job folder, and no-raw-data checks passed."
        : `Template validation failed: ${errors.join("; ")}`
  } as const;
}

export function nextTemplateVersion(count: number) {
  return `v${count + 1}.0.0`;
}
