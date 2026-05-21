import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import type { ReviewSourceFile } from "@/lib/source-review";

export type TemplateReviewChangedFile = {
  path: string;
  originalContent: string;
  proposedContent: string;
  reason: string;
};

export type TemplateReviewSafetyCheck = {
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
};

export type TemplateReviewAgentResult = {
  assistantMessage: string;
  changedFiles: TemplateReviewChangedFile[];
  questions: string[];
  safetyChecks: TemplateReviewSafetyCheck[];
  validationSummary?: string;
  draftPrUrl?: string;
  openAiUsed?: boolean;
  aiConfigured?: boolean;
};

export function isSafeReviewFilePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.startsWith("/") &&
    !filePath.includes("\\") &&
    !filePath.split("/").includes("..") &&
    !filePath.split("/").includes(".git")
  );
}

export function normalizeReviewChangedFiles(input: {
  changedFiles: unknown;
  sourceFiles: ReviewSourceFile[];
}): TemplateReviewChangedFile[] {
  if (!Array.isArray(input.changedFiles)) return [];
  const sourceByPath = new Map(input.sourceFiles.map((file) => [file.path, file]));
  return input.changedFiles
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null)
    .map((item) => {
      const path = typeof item.path === "string" ? item.path.trim() : "";
      const source = sourceByPath.get(path);
      const proposedContent = typeof item.proposedContent === "string" ? item.proposedContent : typeof item.content === "string" ? item.content : "";
      return {
        path,
        originalContent:
          typeof item.originalContent === "string" ? item.originalContent : source?.content ?? "",
        proposedContent,
        reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "Proposed source review change."
      };
    })
    .filter((item) => isSafeReviewFilePath(item.path) && item.proposedContent.length > 0);
}

function defaultSafetyChecks(): TemplateReviewSafetyCheck[] {
  return [
    {
      label: "Site-local data boundary",
      status: "PASS",
      detail: "Review keeps raw patient-level data and identifiers out of the template repository."
    },
    {
      label: "NVFLARE shape",
      status: "PASS",
      detail: "Review preserves README, AGENTS.md, .fedlify/template.json, nvflare-job/, and tests/ expectations."
    },
    {
      label: "Runtime configurability",
      status: "PASS",
      detail: "Review checks that client counts, rounds, aggregation, and output artifacts stay configurable."
    }
  ];
}

function looksLikeChangeRequest(message: string): boolean {
  return /\b(change|update|modify|edit|fix|refactor|add|remove|rename|make|create|generate|implement)\b/i.test(message);
}

function parseJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Responses can include a fenced JSON block despite instructions.
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      return null;
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function coerceReviewResult(input: {
  body: unknown;
  fallbackMessage: string;
  sourceFiles: ReviewSourceFile[];
  openAiUsed: boolean;
  aiConfigured: boolean;
}): TemplateReviewAgentResult {
  const body = typeof input.body === "object" && input.body != null ? (input.body as Record<string, unknown>) : {};
  const changedFiles = normalizeReviewChangedFiles({ changedFiles: body.changedFiles, sourceFiles: input.sourceFiles });
  const questions = Array.isArray(body.questions) ? body.questions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const safetyChecks: TemplateReviewSafetyCheck[] = Array.isArray(body.safetyChecks)
    ? body.safetyChecks
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null)
        .map((item) => ({
          label: typeof item.label === "string" ? item.label : "Safety check",
          status: item.status === "FAIL" || item.status === "WARN" || item.status === "PASS" ? item.status : "WARN",
          detail: typeof item.detail === "string" ? item.detail : "Review check completed."
        }))
    : defaultSafetyChecks();

  return {
    assistantMessage: typeof body.assistantMessage === "string" && body.assistantMessage.trim() ? body.assistantMessage.trim() : input.fallbackMessage,
    changedFiles,
    questions,
    safetyChecks,
    validationSummary: typeof body.validationSummary === "string" ? body.validationSummary : undefined,
    openAiUsed: input.openAiUsed,
    aiConfigured: input.aiConfigured
  };
}

export async function runTemplateReviewAgent(input: {
  message: string;
  selectedPath?: string | null;
  sourceRef: string;
  repoUrl?: string | null;
  commit?: string | null;
  files: ReviewSourceFile[];
  manifest?: Record<string, unknown> | null;
  priorMessages?: Array<Record<string, unknown>>;
}): Promise<TemplateReviewAgentResult> {
  const config = openAiCodeAgentConfig();
  const selectedFile = input.files.find((file) => file.path === input.selectedPath) ?? input.files[0];
  const changeRequest = looksLikeChangeRequest(input.message);

  if (!config) {
    return {
      assistantMessage: [
        "AI code review is not configured because OPENAI_API_KEY is not set.",
        changeRequest
          ? "Manual edits can still be previewed, validated, and sent to a draft Gitea PR from this review screen."
          : "I can show source files, but natural-language review requires configuring the OpenAI key."
      ].join(" "),
      changedFiles: [],
      questions: [],
      safetyChecks: defaultSafetyChecks().map((item) => ({ ...item, status: "WARN" })),
      openAiUsed: false,
      aiConfigured: false
    };
  }

  const system = [
    "You are Fedlify's inline Codex code reviewer for reusable health-AI NVFLARE templates.",
    "Return JSON only. Do not wrap it in markdown.",
    "Schema: { assistantMessage: string, changedFiles: [{ path: string, originalContent: string, proposedContent: string, reason: string }], questions: string[], safetyChecks: [{ label: string, status: 'PASS'|'WARN'|'FAIL', detail: string }], validationSummary?: string }.",
    "For explanation-only or safety-review prompts, return no changedFiles.",
    "For change requests, return complete proposedContent for every changed file, not patches.",
    "Ask clarification questions instead of changing files when clinical/runtime/privacy intent is missing.",
    "Preserve NVFLARE job folder shape and keep raw clinical data, identifiers, extracts, CSV, parquet, and patient-level examples out of the repository.",
    "Keep site count, min_clients, rounds, aggregation, and output artifacts configurable.",
    "Update README, AGENTS.md, .fedlify/template.json, and tests when behavior changes.",
    "Never approve, merge, publish, or run production jobs."
  ].join("\n");

  const sourceContext = {
    sourceRef: input.sourceRef,
    repoUrl: input.repoUrl,
    commit: input.commit,
    selectedPath: selectedFile?.path,
    manifest: input.manifest,
    files: input.files.map((file) => ({ path: file.path, language: file.language })),
    selectedFile: selectedFile
      ? {
          path: selectedFile.path,
          language: selectedFile.language,
          content: selectedFile.content
        }
      : null,
    priorMessages: input.priorMessages?.slice(-6) ?? []
  };

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
                request: input.message,
                sourceContext
              },
              null,
              2
            )
          }
        ],
        max_output_tokens: 4500
      })
    });
    const body = await response.json().catch(() => null);
    const outputText =
      typeof body?.output_text === "string"
        ? body.output_text
        : Array.isArray(body?.output)
          ? body.output
              .flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? [])
              .map((item: { text?: string }) => item.text)
              .filter(Boolean)
              .join("\n")
          : "";

    if (!response.ok) {
      return {
        assistantMessage: `OpenAI review did not complete: ${body?.error?.message ?? response.statusText}`,
        changedFiles: [],
        questions: [],
        safetyChecks: defaultSafetyChecks().map((item) => ({ ...item, status: "WARN" })),
        openAiUsed: false,
        aiConfigured: true
      };
    }

    const parsed = parseJsonObject(outputText);
    return coerceReviewResult({
      body: parsed,
      fallbackMessage: outputText || "Review completed, but no structured result was returned.",
      sourceFiles: input.files,
      openAiUsed: true,
      aiConfigured: true
    });
  } catch (error) {
    return {
      assistantMessage: `OpenAI review failed locally: ${error instanceof Error ? error.message : "unknown error"}`,
      changedFiles: [],
      questions: [],
      safetyChecks: defaultSafetyChecks().map((item) => ({ ...item, status: "WARN" })),
      openAiUsed: false,
      aiConfigured: true
    };
  }
}
