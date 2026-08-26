import { z } from "zod";
import { coordinatorAdvisorySchema } from "@/lib/control-intake";

const executionResponseSchema = z.object({
  output: z.unknown(),
  execution: z.object({
    workItemId: z.string(),
    role: z.string(),
    provider: z.string().optional(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    promptHash: z.string(),
    evidenceHash: z.string().optional(),
    outputHash: z.string(),
    stopReason: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    requests: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional()
  })
});

const intakeAdvisoryResponseSchema = z.object({
  output: coordinatorAdvisorySchema,
  execution: z.object({
    role: z.literal("COORDINATOR"),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    promptHash: z.string(),
    outputHash: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    stopReason: z.literal("ADVISORY_COMPLETED")
  })
});

async function orchestratorRequest(path: string, body: unknown) {
  const baseUrl = process.env.FEDLIFY_ORCHESTRATOR_URL;
  const token = process.env.FEDLIFY_ORCHESTRATOR_TOKEN;
  if (!baseUrl || !token) throw new Error("Fedlify agent orchestrator is not configured.");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.FEDLIFY_AGENT_TIMEOUT_MS ?? 120_000)),
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Orchestrator rejected execution: ${JSON.stringify(payload)}`);
  return payload;
}

export async function executeThroughOrchestrator(body: unknown) {
  return executionResponseSchema.parse(await orchestratorRequest("/v1/work-items/execute", body));
}

export async function analyzeIntakeThroughOrchestrator(body: {
  profile: "hosted" | "local";
  intake: { actor: string; studyContext: string; prompt: string; fixtureName: string; fixtureContent: string };
}) {
  return intakeAdvisoryResponseSchema.parse(await orchestratorRequest("/v1/intake/analyze", body));
}
