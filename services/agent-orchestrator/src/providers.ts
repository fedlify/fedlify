import { Agent, Runner } from "@openai/agents";
import { z } from "zod";

export type ProviderProfile = {
  name: string;
  provider: "openai" | "openai-compatible";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  reasoningEffort?: "low" | "medium" | "high";
};

const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
const privateRunner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });

export interface ModelProvider {
  readonly profile: ProviderProfile;
  structured<T>(name: string, instructions: string, prompt: string, schema: z.ZodType<T>, options?: { timeoutMs?: number; maxTokens?: number }): Promise<{
    output: T;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number };
    durationMs: number;
  }>;
}

class AgentsSdkProvider implements ModelProvider {
  constructor(readonly profile: ProviderProfile) {}

  async structured<T>(name: string, instructions: string, prompt: string, schema: z.ZodType<T>, options: { timeoutMs?: number; maxTokens?: number } = {}) {
    const started = performance.now();
    const agent = new Agent({
      name,
      instructions,
      model: this.profile.model,
      modelSettings: {
        reasoning: this.profile.reasoningEffort ? { effort: this.profile.reasoningEffort } : undefined,
        maxTokens: options.maxTokens,
        store: false
      },
      outputType: schema
    });
    const result = await privateRunner.run(agent, prompt, {
      maxTurns: 1,
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.FEDLIFY_AGENT_TIMEOUT_MS ?? 120_000))
    });
    const usage = result.state.usage;
    return {
      output: schema.parse(result.finalOutput),
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, requests: usage.requests },
      durationMs: Math.round(performance.now() - started)
    };
  }
}

class OpenAiCompatibleProvider implements ModelProvider {
  constructor(readonly profile: ProviderProfile) {}

  async structured<T>(_name: string, instructions: string, prompt: string, schema: z.ZodType<T>, options: { timeoutMs?: number; maxTokens?: number } = {}) {
    if (!this.profile.baseUrl) throw new Error("Local provider requires FEDLIFY_LOCAL_MODEL_BASE_URL.");
    const started = performance.now();
    const response = await fetch(`${this.profile.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.profile.apiKey ? { authorization: `Bearer ${this.profile.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.profile.model,
        temperature: 0,
        max_tokens: options.maxTokens,
        messages: [{ role: "system", content: instructions }, { role: "user", content: prompt }],
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? Number(process.env.FEDLIFY_AGENT_TIMEOUT_MS ?? 120_000))
    });
    if (!response.ok) throw new Error(`Local model returned HTTP ${response.status}.`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Local model returned no structured content.");
    return {
      output: schema.parse(JSON.parse(content)),
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? 0,
        requests: 1
      },
      durationMs: Math.round(performance.now() - started)
    };
  }
}

export async function preflightProvider(profileName: string) {
  const provider = providerFor(profileName);
  const result = await provider.structured(
    "Fedlify provider preflight",
    "Return the required structured object and nothing else.",
    JSON.stringify({ status: "ok" }),
    z.object({ status: z.literal("ok") })
  );
  return {
    profile: provider.profile,
    ...result.usage,
    durationMs: result.durationMs,
    structuredOutput: result.output.status === "ok"
  };
}

export function profileFromEnvironment(profileName: string): ProviderProfile {
  if (profileName === "local") {
    return {
      name: "local",
      provider: "openai-compatible",
      model: process.env.FEDLIFY_LOCAL_MODEL_NAME ?? "gpt-oss:20b",
      baseUrl: process.env.FEDLIFY_LOCAL_MODEL_BASE_URL,
      apiKey: process.env.FEDLIFY_LOCAL_MODEL_API_KEY
    };
  }
  if (profileName !== "hosted") throw new Error(`Unknown provider profile: ${profileName}.`);
  return {
    name: "hosted",
    provider: "openai",
    model: process.env.FEDLIFY_HOSTED_MODEL ?? "gpt-5.6-sol",
    // Not every hosted model supports a reasoning-effort parameter. Leaving the env var unset
    // omits it entirely (see AgentsSdkProvider.structured) instead of forcing "medium" onto a
    // model that will reject it — required for the hosted model to actually be swappable (P8).
    reasoningEffort: process.env.FEDLIFY_HOSTED_REASONING_EFFORT
      ? reasoningEffortSchema.parse(process.env.FEDLIFY_HOSTED_REASONING_EFFORT)
      : undefined
  };
}

export function providerFor(profileName: string): ModelProvider {
  const profile = profileFromEnvironment(profileName);
  return profile.provider === "openai" ? new AgentsSdkProvider(profile) : new OpenAiCompatibleProvider(profile);
}
