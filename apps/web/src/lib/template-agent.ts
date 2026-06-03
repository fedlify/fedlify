import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import type { TemplateIntakeAnswers } from "@/lib/pipeline-template-code";

export type TemplateAgentIntake = Partial<
  TemplateIntakeAnswers & {
    templateName: string;
    description: string;
    agentRequest: string;
  }
>;

export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

const requiredFields: Array<{ key: keyof TemplateAgentIntake; label: string }> = [
  { key: "templateName", label: "template name" },
  { key: "agentRequest", label: "what the template should do" },
  { key: "purpose", label: "template purpose" },
  { key: "clinicalUseCase", label: "clinical AI use case" },
  { key: "dataModalities", label: "data modalities" },
  { key: "siteLocalInputs", label: "site-local input contract" },
  { key: "syntheticFixtures", label: "allowed synthetic fixtures" },
  { key: "nvflareWorkflow", label: "NVFLARE workflow type" },
  { key: "minClients", label: "minimum clients" },
  { key: "numRounds", label: "federated rounds" },
  { key: "aggregation", label: "aggregation behavior" },
  { key: "artifactOutputs", label: "output artifacts" },
  { key: "dependencyPolicy", label: "dependency policy" },
  { key: "privacyConstraints", label: "privacy constraints" },
  { key: "reviewExpectations", label: "validation expectations" }
];

export function missingTemplateAgentFields(intake: TemplateAgentIntake): string[] {
  return requiredFields
    .filter((field) => {
      const value = intake[field.key];
      if (field.key === "dataModalities") return !Array.isArray(value) || value.length === 0;
      if (field.key === "minClients" || field.key === "numRounds") return !Number.isInteger(Number(value)) || Number(value) < 1;
      return typeof value !== "string" || value.trim().length < 3;
    })
    .map((field) => field.label);
}

export function templateIntakeAnswersFromAgent(intake: TemplateAgentIntake): TemplateIntakeAnswers {
  return {
    purpose: String(intake.purpose),
    clinicalUseCase: String(intake.clinicalUseCase),
    dataModalities: Array.isArray(intake.dataModalities) ? intake.dataModalities.map(String) : [],
    siteLocalInputs: String(intake.siteLocalInputs),
    syntheticFixtures: String(intake.syntheticFixtures),
    nvflareWorkflow: String(intake.nvflareWorkflow),
    minClients: Number(intake.minClients),
    numRounds: Number(intake.numRounds),
    aggregation: String(intake.aggregation),
    privacyConstraints: String(intake.privacyConstraints),
    dependencyPolicy: String(intake.dependencyPolicy),
    artifactOutputs: String(intake.artifactOutputs),
    reviewExpectations: String(intake.reviewExpectations)
  };
}

function fallbackAgentMessage(input: { missing: string[]; userMessage?: string }) {
  if (input.missing.length > 0) {
    return [
      "I need a few details before generating NVFLARE code.",
      "",
      `Missing: ${input.missing.join(", ")}.`,
      "",
      "I will keep runtime parameters configurable, preserve the NVFLARE job folder shape, and avoid raw-data paths."
    ].join("\n");
  }

  return [
    "The intake is complete. I can generate a draft NVFLARE template PR now.",
    "",
    "The generated code will include README, AGENTS.md, `.fedlify/template.json`, `nvflare-job/`, tests, configurable runtime defaults, and a site-local data contract.",
    input.userMessage ? `Last request considered: ${input.userMessage}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function extractResponseText(body: unknown): string | null {
  if (typeof body !== "object" || body == null) return null;
  const maybe = body as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown; type?: string }> }>;
  };
  if (typeof maybe.output_text === "string" && maybe.output_text.trim()) return maybe.output_text.trim();
  const text = maybe.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  return text || null;
}

const SYSTEM_PROMPT = [
  "You are Fedlify's NVFLARE pipeline development agent for health AI federated learning.",
  "You help research teams design and generate complete, runnable NVFLARE federated learning pipelines.",
  "",
  "## Your capabilities",
  "- Guide users through intake (clinical use case, data modalities, privacy constraints, aggregation strategy)",
  "- Generate complete Python code for SiteLocalExecutor including a real training loop",
  "- Generate NVFlare configuration files (server config, client config, meta.conf)",
  "- Explain federated learning concepts, FedAvg, differential privacy, and NVFlare APIs",
  "- Propose code changes when the user asks to adjust existing pipelines",
  "",
  "## When to generate code",
  "Once all required intake fields are filled, generate a complete SiteLocalExecutor implementation.",
  "The executor must follow this NVFlare Executor pattern:",
  "```python",
  "import numpy as np",
  "from nvflare.apis.executor import Executor",
  "from nvflare.apis.fl_context import FLContext",
  "from nvflare.apis.signal import Signal",
  "from nvflare.apis.shareable import Shareable, make_reply",
  "from nvflare.apis.dxo import DXO, DataKind",
  "from nvflare.app_common.app_constant import AppConstants",
  "",
  "class SiteLocalExecutor(Executor):",
  "    def __init__(self, data_boundary='site-only', lr=0.01, local_epochs=1):",
  "        super().__init__()",
  "        self.data_boundary = data_boundary",
  "        self.lr = lr",
  "        self.local_epochs = local_epochs",
  "",
  "    def execute(self, task_name: str, shareable: Shareable, fl_ctx: FLContext, abort_signal: Signal) -> Shareable:",
  "        if task_name != AppConstants.TASK_TRAIN:",
  "            return make_reply(ReturnCode.TASK_UNKNOWN)",
  "        # 1. Extract global model weights from incoming shareable",
  "        incoming_dxo = DXO.from_shareable(shareable)",
  "        global_weights = incoming_dxo.data  # dict of param_name -> np.ndarray",
  "        # 2. Load site-local data (path from fl_ctx or environment)",
  "        # data_path = fl_ctx.get_prop('data_path', '/data/local')",
  "        # X_train, y_train = load_site_data(data_path)",
  "        # 3. Run local training loop",
  "        # model.load_state_dict(global_weights)",
  "        # for epoch in range(self.local_epochs):",
  "        #     loss = train_one_epoch(model, X_train, y_train, self.lr)",
  "        # 4. Return updated weights as DXO",
  "        updated_weights = global_weights  # replace with model.state_dict()",
  "        out_dxo = DXO(data_kind=DataKind.WEIGHTS, data=updated_weights, meta={AppConstants.NUM_STEPS_CURRENT_ROUND: self.local_epochs})",
  "        return out_dxo.to_shareable()",
  "```",
  "",
  "## Rules",
  "- Never commit raw clinical data, patient identifiers, extracts, or site-local dataset files",
  "- Keep site count, min_clients, num_rounds, and aggregation configurable via NVFlare conf files",
  "- Preserve repository shape: README.md, AGENTS.md, .fedlify/template.json, nvflare-job/, tests/",
  "- Never claim production approval or run production jobs",
  "- When generating executor code: produce complete, runnable Python — not pseudocode or placeholders",
  "- Include imports, class definition, __init__, and execute() with real logic for the stated use case"
].join("\n");

export async function runTemplateAgentAssistant(input: {
  mode: string;
  intake: TemplateAgentIntake;
  userMessage?: string;
  sourceSummary?: string;
  priorMessages?: AgentMessage[];
}): Promise<{ message: string; modelUsed: string | null; missing: string[]; openAiUsed: boolean }> {
  const missing = missingTemplateAgentFields(input.intake);
  const config = openAiCodeAgentConfig();
  if (!config) {
    return { message: fallbackAgentMessage({ missing, userMessage: input.userMessage }), modelUsed: null, missing, openAiUsed: false };
  }

  // Build conversation history (last 8 messages) then append the current user turn
  const historyMessages = (input.priorMessages ?? [])
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));

  const currentUserContent = JSON.stringify(
    {
      mode: input.mode,
      intake: input.intake,
      missing,
      sourceSummary: input.sourceSummary,
      userMessage: input.userMessage
    },
    null,
    2
  );

  const inputMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...historyMessages,
    { role: "user", content: currentUserContent }
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        input: inputMessages,
        max_output_tokens: 8192
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        message: `${fallbackAgentMessage({ missing, userMessage: input.userMessage })}\n\nOpenAI call did not complete: ${
          (body as { error?: { message?: string } } | null)?.error?.message ?? response.statusText
        }`,
        modelUsed: config.model,
        missing,
        openAiUsed: false
      };
    }

    return {
      message: extractResponseText(body) ?? fallbackAgentMessage({ missing, userMessage: input.userMessage }),
      modelUsed: config.model,
      missing,
      openAiUsed: true
    };
  } catch (error) {
    return {
      message: `${fallbackAgentMessage({ missing, userMessage: input.userMessage })}\n\nOpenAI call failed locally: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      modelUsed: config.model,
      missing,
      openAiUsed: false
    };
  }
}

const EXECUTOR_GENERATION_PROMPT = [
  "You are a Python code generator for NVFlare federated learning executors.",
  "Generate a complete, runnable SiteLocalExecutor class for the given clinical use case and intake.",
  "",
  "Requirements:",
  "- Use the NVFlare Executor API (nvflare.apis.executor.Executor)",
  "- Include all imports at the top",
  "- Implement __init__ with configurable hyperparameters (lr, local_epochs, etc.)",
  "- Implement execute(task_name, shareable, fl_ctx, abort_signal) -> Shareable",
  "- Extract global model weights from incoming DXO",
  "- Include commented placeholders for site-local data loading",
  "- Run a local training loop (commented out if framework is unknown, real code if sklearn/numpy/torch is specified)",
  "- Return updated weights as a DXO",
  "- Add a privacy-preserving step (e.g. weight clipping) if privacyConstraints mentions differential privacy",
  "- Output ONLY the Python source code — no markdown, no explanation, no fences",
  "- The class must be named SiteLocalExecutor"
].join("\n");

export async function generateExecutorCode(
  intake: TemplateAgentIntake,
  config: { apiKey: string; model: string }
): Promise<string | null> {
  const prompt = JSON.stringify(
    {
      clinicalUseCase: intake.clinicalUseCase,
      dataModalities: intake.dataModalities,
      nvflareWorkflow: intake.nvflareWorkflow,
      aggregation: intake.aggregation,
      privacyConstraints: intake.privacyConstraints,
      siteLocalInputs: intake.siteLocalInputs,
      dependencyPolicy: intake.dependencyPolicy,
      purpose: intake.purpose
    },
    null,
    2
  );

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        input: [
          { role: "system", content: EXECUTOR_GENERATION_PROMPT },
          { role: "user", content: prompt }
        ],
        max_output_tokens: 4096
      })
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const text = extractResponseText(body);
    if (!text) return null;
    // Strip markdown fences if the model wrapped the code despite instructions
    return text.replace(/^```(?:python)?\n?/, "").replace(/\n?```$/, "").trim();
  } catch {
    return null;
  }
}
