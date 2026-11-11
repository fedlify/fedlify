/** Asks the code model to draft the site-side training class for a pipeline from the template's own settings. */
export type ExecutorIntake = Record<string, unknown>;

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
  intake: ExecutorIntake,
  config: { apiKey: string; model: string }
): Promise<string | null> {
  const prompt = JSON.stringify(
    {
      clinicalUseCase: intake.clinicalUseCase,
      dataModalities: intake.dataModalities,
      nvflareWorkflow: intake.nvflareWorkflow,
      aggregation: intake.aggregation,
      privacyConstraints: intake.privacyConstraints,
      collaborationSetting: intake.collaborationSetting,
      dataDistribution: intake.dataDistribution,
      systemTopology: intake.systemTopology,
      privacySecurityPlan: intake.privacySecurityPlan,
      trainingStrategy: intake.trainingStrategy,
      clinicalApplication: intake.clinicalApplication,
      diseaseCategory: intake.diseaseCategory,
      challengeProfile: intake.challengeProfile,
      outcomeDefinition: intake.outcomeDefinition,
      participatingSites: intake.participatingSites,
      governanceContact: intake.governanceContact,
      dataReadinessSummary: intake.dataReadinessSummary,
      siteConstraints: intake.siteConstraints,
      approvalStatus: intake.approvalStatus,
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
