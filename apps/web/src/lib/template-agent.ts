import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import type { TemplateIntakeAnswers } from "@/lib/pipeline-template-code";

export type TemplateAgentIntake = Partial<
  TemplateIntakeAnswers & {
    templateName: string;
    description: string;
    agentRequest: string;
  }
>;

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

export async function runTemplateAgentAssistant(input: {
  mode: string;
  intake: TemplateAgentIntake;
  userMessage?: string;
  sourceSummary?: string;
}): Promise<{ message: string; modelUsed: string | null; missing: string[]; openAiUsed: boolean }> {
  const missing = missingTemplateAgentFields(input.intake);
  const config = openAiCodeAgentConfig();
  if (!config) {
    return { message: fallbackAgentMessage({ missing, userMessage: input.userMessage }), modelUsed: null, missing, openAiUsed: false };
  }

  const system = [
    "You are Fedlify's Codex-style NVFLARE template agent.",
    "You help health-AI teams create federated learning templates through intake plus draft pull requests.",
    "Never claim production approval, never run production jobs, and never ask users to place raw clinical data in code repositories.",
    "Ask concrete missing questions before coding. Keep site count, min clients, rounds, and aggregation configurable.",
    "Preserve this repository shape: README.md, AGENTS.md, .fedlify/template.json, nvflare-job/, tests/.",
    "Mention validation and human approval gates when discussing code generation."
  ].join("\n");

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
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify(
              {
                mode: input.mode,
                intake: input.intake,
                missing,
                sourceSummary: input.sourceSummary,
                userMessage: input.userMessage
              },
              null,
              2
            )
          }
        ],
        max_output_tokens: 700
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
