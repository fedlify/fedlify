import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PipelineTemplate, Study, StudySite } from "@prisma/client";
import { nvflarePython, openAiCodeAgentConfig, runtimeRoot } from "@/lib/runtime-config";
import { generateExecutorCode } from "@/lib/template-agent";
import { slugify } from "@/lib/slug";

const execFileAsync = promisify(execFile);
const NVFLARE_JOB_FOLDER = "nvflare-job";

export type NvflareRuntimeParameters = {
  numClients: number;
  minClients: number;
  numRounds: number;
};

export type PipelineFile = {
  path: string;
  content: string;
};

export type PipelineValidationResult = {
  status: "PASSED" | "FAILED";
  summary: string;
  errors: string[];
};

export function pipelineProjectSlug(studyTitle: string, projectName: string, prefix = "fedlify"): string {
  return [prefix, slugify(studyTitle).slice(0, 36), slugify(projectName).slice(0, 36)].filter(Boolean).join("-");
}

export function runtimeParametersForSelectedSites(input: {
  selectedSiteCount: number;
  minClients?: number | null;
  numRounds?: number | null;
}): NvflareRuntimeParameters {
  const selectedSiteCount = Math.max(1, Math.floor(input.selectedSiteCount));
  const requestedMinClients = input.minClients == null ? selectedSiteCount : Math.floor(input.minClients);
  const minClients = Math.min(selectedSiteCount, Math.max(1, requestedMinClients));
  const numRounds = Math.max(1, Math.floor(input.numRounds ?? 1));
  return {
    numClients: selectedSiteCount,
    minClients,
    numRounds
  };
}

export function buildPipelineFiles(input: {
  study: Pick<Study, "id" | "title" | "slug" | "goal" | "researchQuestion" | "clinicalUseCase" | "dataModalities" | "intendedUse">;
  template: Pick<PipelineTemplate, "name" | "templateKey" | "framework" | "version" | "spec">;
  projectName: string;
  prompt: string;
  sites: Array<Pick<StudySite, "id" | "code" | "name" | "institutionName"> & { site?: { nvflareClientName: string } | null }>;
}): PipelineFile[] {
  const participantConfig = input.sites.map((site) => ({
    studySiteId: site.id,
    code: site.code,
    name: site.name,
    institutionName: site.institutionName,
    nvflareClientName: site.site?.nvflareClientName ?? `site-${site.code}`
  }));

  const manifest = {
    packageType: "fedlify-nvflare-pipeline",
    version: "1.0.0",
    projectName: input.projectName,
    study: {
      id: input.study.id,
      title: input.study.title,
      slug: input.study.slug,
      goal: input.study.goal,
      researchQuestion: input.study.researchQuestion,
      clinicalUseCase: input.study.clinicalUseCase,
      dataModalities: input.study.dataModalities,
      intendedUse: input.study.intendedUse
    },
    template: {
      name: input.template.name,
      key: input.template.templateKey,
      framework: input.template.framework,
      version: input.template.version,
      spec: input.template.spec
    },
    participants: participantConfig,
    dataBoundary: "site-only",
    rawDataPolicy: "Do not commit raw clinical data, patient identifiers, extracts, or site-local dataset files.",
    requestedChange: input.prompt
  };

  return [
    {
      path: "README.md",
      content: [
        `# ${input.projectName}`,
        "",
        `Study: ${input.study.title}`,
        "",
        "This repository contains reviewed NVFLARE application code for a Fedlify-governed federated learning study.",
        "Raw clinical data must remain at participant sites. Only code, schemas, and synthetic fixtures belong here.",
        "",
        "## Review gates",
        "- CI validation must pass.",
        "- A human reviewer must approve the immutable commit in Fedlify.",
        "- Sites can still reject jobs through local NVFLARE policy.",
        ""
      ].join("\n")
    },
    { path: "fedlify-pipeline.json", content: JSON.stringify(manifest, null, 2) },
    {
      path: "nvflare/app/config/config_fed_server.json",
      content: JSON.stringify(
        {
          format_version: 2,
          workflows: [
            {
              id: "fedlify_controller",
              path: "nvflare.app_common.workflows.fedavg.FedAvg",
              args: {
                num_clients: Math.max(1, participantConfig.length),
                min_clients: Math.max(1, participantConfig.length),
                num_rounds: 1
              }
            }
          ],
          components: []
        },
        null,
        2
      )
    },
    {
      path: "nvflare/app/config/config_fed_client.json",
      content: JSON.stringify(
        {
          format_version: 2,
          executors: [
            {
              tasks: ["train"],
              executor: {
                path: "fedlify_pipeline.executor.SiteLocalExecutor",
                args: {
                  data_boundary: "site-only"
                }
              }
            }
          ],
          components: []
        },
        null,
        2
      )
    },
    {
      path: "fedlify_pipeline/executor.py",
      content: EXECUTOR_STUB
    },
    {
      path: "tests/test_pipeline_manifest.py",
      content: [
        "import json",
        "from pathlib import Path",
        "",
        "def test_manifest_keeps_data_site_local():",
        "    manifest = json.loads(Path('fedlify-pipeline.json').read_text())",
        "    assert manifest['dataBoundary'] == 'site-only'",
        "    assert 'raw clinical data' in manifest['rawDataPolicy'].lower()",
        ""
      ].join("\n")
    }
  ];
}

const EXECUTOR_STUB = [
  "# GENERATED_STUB: replace before production use",
  "# This file will be replaced by the AI agent when intake is complete.",
  "from nvflare.apis.executor import Executor",
  "from nvflare.apis.shareable import Shareable, make_reply",
  "from nvflare.apis.fl_context import FLContext",
  "from nvflare.apis.signal import Signal",
  "from nvflare.apis.return_code import ReturnCode",
  "",
  "",
  "class SiteLocalExecutor(Executor):",
  "    def __init__(self, data_boundary='site-only'):",
  "        super().__init__()",
  "        self.data_boundary = data_boundary",
  "",
  "    def execute(self, task_name: str, shareable: Shareable, fl_ctx: FLContext, abort_signal: Signal) -> Shareable:",
  "        raise NotImplementedError('Replace with reviewed site-local training logic before production use.')",
  ""
].join("\n");

const syntheticNumpyClient = [
  "import time",
  "import numpy as np",
  "import nvflare.client as flare",
  "from nvflare.client import FLModel",
  "",
  "",
  "def _params(model):",
  "    if model and model.params:",
  "        return {key: np.asarray(value) for key, value in model.params.items()}",
  "    return {'weight': np.zeros((2,), dtype=np.float32)}",
  "",
  "",
  "def main():",
  "    flare.init(config_file='client_api_config.json')",
  "    try:",
  "        while flare.is_running():",
  "            model = flare.receive(timeout=30)",
  "            if model is None:",
  "                time.sleep(1)",
  "                continue",
  "            params = {key: value + 0.01 for key, value in _params(model).items()}",
  "            flare.send(FLModel(params=params, metrics={'accuracy': 1.0}, meta={'NUM_STEPS_CURRENT_ROUND': 1}))",
  "    finally:",
  "        flare.shutdown()",
  "",
  "",
  "if __name__ == '__main__':",
  "    main()",
  ""
].join("\n");

function stripTensorboardReceiver(config: string) {
  return config.replace(
    /,\n\s*\{\n\s*id = "tb_analytics_receiver"\n\s*path = "nvflare\.app_opt\.tracking\.tb\.tb_receiver\.TBAnalyticsReceiver"\n\s*args\.events = \["fed\.analytix_log_stats"\]\n\s*\}/,
    ""
  );
}

async function readDirectoryFiles(directory: string, prefix: string): Promise<PipelineFile[]> {
  const files: PipelineFile[] = [];
  const entries = await readdir(directory);
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    const relativePath = `${prefix}/${entry}`;
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      files.push(...(await readDirectoryFiles(absolutePath, relativePath)));
    } else if (info.isFile()) {
      files.push({ path: relativePath, content: await readFile(absolutePath, "utf8") });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildNvflareJobPipelineFiles(input: Parameters<typeof buildPipelineFiles>[0] & { templateSpec?: Record<string, unknown> }): Promise<PipelineFile[]> {
  let baseFiles = buildPipelineFiles(input).filter((file) => !file.path.startsWith("nvflare/"));

  // Attempt to generate real executor code via the agent
  const aiConfig = openAiCodeAgentConfig();
  if (aiConfig) {
    const generatedCode = await generateExecutorCode(
      { ...(input.templateSpec ?? {}), ...(typeof input.template.spec === "object" && input.template.spec !== null ? (input.template.spec as Record<string, unknown>) : {}) },
      aiConfig
    ).catch(() => null);
    if (generatedCode) {
      baseFiles = baseFiles.map((f) =>
        f.path === "fedlify_pipeline/executor.py" ? { ...f, content: generatedCode } : f
      );
    }
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fedlify-nvflare-job-"));
  const jobPath = path.join(tempRoot, NVFLARE_JOB_FOLDER);

  try {
    await execFileAsync("nvflare", ["job", "create", "-j", jobPath, "-w", "sag_np_metrics", "-force"], {
      timeout: 60_000,
      env: { ...process.env, PYTHON: nvflarePython() }
    });
    await mkdir(path.join(jobPath, "app", "custom"), { recursive: true });
    await writeFile(path.join(jobPath, "app", "custom", "cifar10.py"), syntheticNumpyClient);
    const defaultMinClients = Math.max(1, input.sites.length);
    const metaConfigPath = path.join(jobPath, "meta.conf");
    await writeFile(metaConfigPath, replaceConfigValue(await readFile(metaConfigPath, "utf8"), "min_clients", defaultMinClients));
    const serverConfigPath = path.join(jobPath, "app", "config", "config_fed_server.conf");
    const serverConfig = replaceConfigValue(stripTensorboardReceiver(await readFile(serverConfigPath, "utf8")), "min_clients", defaultMinClients);
    await writeFile(serverConfigPath, serverConfig);
    const jobFiles = await readDirectoryFiles(jobPath, NVFLARE_JOB_FOLDER);
    return [
      ...baseFiles,
      {
        path: `${NVFLARE_JOB_FOLDER}/README.md`,
        content: [
          "# NVFLARE smoke job",
          "",
          "This folder was generated with `nvflare job create -w sag_np_metrics` and includes a synthetic numpy client script.",
          "Fedlify removes the optional TensorBoard receiver from the smoke job so the local Docker image does not require PyTorch.",
          "It is suitable for validating Fedlify runtime plumbing only. Sites must replace the synthetic script with approved study logic before production use.",
          ""
        ].join("\n")
      },
      ...jobFiles
    ];
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function writeNvflareJobWorkspace(input: { files: PipelineFile[]; destination: string }): Promise<void> {
  await rm(input.destination, { recursive: true, force: true });
  for (const file of input.files) {
    if (!file.path.startsWith(`${NVFLARE_JOB_FOLDER}/`)) continue;
    const relativePath = file.path.slice(NVFLARE_JOB_FOLDER.length + 1);
    const destination = path.join(input.destination, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
}

export function pipelineJobWorkspacePath(input: { studyId: string; pipelineVersionId: string }): string {
  return path.join(runtimeRoot(), "pipelines", input.studyId, input.pipelineVersionId, NVFLARE_JOB_FOLDER);
}

export function pipelineRunWorkspacePath(input: { studyId: string; jobId: string }): string {
  return path.join(runtimeRoot(), "runs", input.studyId, input.jobId, NVFLARE_JOB_FOLDER);
}

function replaceConfigValue(content: string, key: string, value: number) {
  const pattern = new RegExp(`(^\\s*${key}\\s*=\\s*)\\d+`, "m");
  if (pattern.test(content)) return content.replace(pattern, `$1${value}`);
  return `${content.trimEnd()}\n  ${key} = ${value}\n`;
}

export async function prepareNvflareJobWorkspaceForRun(input: {
  sourceWorkspacePath: string;
  destinationWorkspacePath: string;
  runtimeParameters: NvflareRuntimeParameters;
}): Promise<void> {
  await rm(input.destinationWorkspacePath, { recursive: true, force: true });
  await mkdir(path.dirname(input.destinationWorkspacePath), { recursive: true });
  await cp(input.sourceWorkspacePath, input.destinationWorkspacePath, { recursive: true });

  const metaPath = path.join(input.destinationWorkspacePath, "meta.conf");
  const serverConfigPath = path.join(input.destinationWorkspacePath, "app", "config", "config_fed_server.conf");

  await writeFile(metaPath, replaceConfigValue(await readFile(metaPath, "utf8"), "min_clients", input.runtimeParameters.minClients));

  let serverConfig = await readFile(serverConfigPath, "utf8");
  serverConfig = replaceConfigValue(serverConfig, "min_clients", input.runtimeParameters.minClients);
  serverConfig = replaceConfigValue(serverConfig, "num_rounds", input.runtimeParameters.numRounds);
  await writeFile(serverConfigPath, serverConfig);
}

export function validatePipelineFiles(files: PipelineFile[]): PipelineValidationResult {
  const paths = new Set(files.map((file) => file.path));
  const requiredBase = ["README.md", "fedlify-pipeline.json"];
  const requiredRuntimeJob = [
    `${NVFLARE_JOB_FOLDER}/meta.conf`,
    `${NVFLARE_JOB_FOLDER}/app/config/config_fed_server.conf`,
    `${NVFLARE_JOB_FOLDER}/app/config/config_fed_client.conf`,
    `${NVFLARE_JOB_FOLDER}/app/custom/cifar10.py`
  ];
  const requiredLegacyShape = ["nvflare/app/config/config_fed_server.json", "nvflare/app/config/config_fed_client.json"];
  const errors = requiredBase.filter((path) => !paths.has(path)).map((path) => `Missing required file: ${path}`);
  const hasRuntimeJob = requiredRuntimeJob.every((path) => paths.has(path));
  const hasLegacyShape = requiredLegacyShape.every((path) => paths.has(path));
  if (!hasRuntimeJob && !hasLegacyShape) {
    for (const missing of requiredRuntimeJob.filter((path) => !paths.has(path))) {
      errors.push(`Missing required file: ${missing}`);
    }
  }
  const prohibitedPathPatterns = [/patient/i, /patients/i, /clinical[-_ ]?extract/i, /raw[-_ ]?data/i, /\.csv$/i, /\.parquet$/i];

  for (const file of files) {
    if (file.path !== "README.md" && file.path !== "fedlify-pipeline.json" && prohibitedPathPatterns.some((pattern) => pattern.test(file.path))) {
      errors.push(`Pipeline bundle contains a prohibited data-like path: ${file.path}`);
    }
  }

  return {
    status: errors.length === 0 ? "PASSED" : "FAILED",
    errors,
    summary:
      errors.length === 0
        ? "Template shape, NVFLARE app config, and no-raw-data path checks passed."
        : `Pipeline validation failed: ${errors.join("; ")}`
  };
}

export function filesToArchiveMap(files: PipelineFile[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
}
