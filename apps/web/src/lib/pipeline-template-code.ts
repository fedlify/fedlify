import type { PipelineTemplate } from "@prisma/client";
import { buildNvflareJobPipelineFiles, type PipelineFile } from "@/lib/pipeline-code";
import { slugify } from "@/lib/slug";

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
    reviewExpectations: input.intake.reviewExpectations
  };
}

export async function buildTemplateRepositoryFiles(input: {
  name: string;
  templateKey: string;
  description?: string | null;
  prompt: string;
  intake: TemplateIntakeAnswers;
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
