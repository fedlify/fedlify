/**
 * The one place the assistant's model calls leave the web app.
 *
 * ASSISTANT_MODEL_ROUTE=direct (default): the request goes to the model provider exactly as before.
 * ASSISTANT_MODEL_ROUTE=orchestrator: the request goes to the agent orchestrator (/v1/work-items/respond) together with
 * the signed work item it belongs to and a short-lived signature over the request hash. The orchestrator checks both,
 * enforces the signed token and time budgets, and holds the provider key.
 *
 * With the orchestrator route there is no fallback: no signed work item means no model call.
 * The prompts are still built by the callers; this module only sends them.
 */

import { prisma } from "@/lib/prisma";
import { contentHash, signControlPayload } from "@/lib/control-plane";
import { buildWorkItemSignedPayload } from "@/lib/control-plane-store";
import { orchestratorFetch } from "@/lib/orchestrator-client";
import { assistantModelRoute } from "@/lib/runtime-config";
import { randomUUID } from "node:crypto";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export class AssistantModelError extends Error {
  constructor(message: string, readonly code: "not_signed" | "not_configured" | "unreachable") {
    super(message);
    this.name = "AssistantModelError";
  }
}

export type AssistantModelCall = {
  config: { apiKey: string; model: string };
  /** The work item the control layer signed for this turn. Required when the route is "orchestrator". */
  workItemId?: string | null;
  studyId: string;
  /** The Responses API body without the stream flag (model, input, max_output_tokens, store, text...). */
  request: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
};

export type ModelUsage = { inputTokens: number; outputTokens: number };

/** Token counts from a Responses API body (or the response object inside a response.completed event). */
export function usageOf(body: unknown): ModelUsage | null {
  const usage = body && typeof body === "object" ? (body as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") return null;
  const { input_tokens, output_tokens } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  if (typeof input_tokens !== "number" && typeof output_tokens !== "number") return null;
  return { inputTokens: Number(input_tokens) || 0, outputTokens: Number(output_tokens) || 0 };
}

export function tokensOf(usage: ModelUsage | null): { input: number; output: number } | undefined {
  return usage ? { input: usage.inputTokens, output: usage.outputTokens } : undefined;
}

/** Rebuilds the signed payload from the stored work item and checks its signature. Null when it cannot be proven signed. */
async function loadSignedWorkItem(workItemId: string, studyId: string) {
  const row = await prisma.workItem.findUnique({ where: { id: workItemId } });
  if (!row || row.studyId !== studyId || !row.signature || row.status !== "SIGNED" || row.controlState !== "WORK_ITEM_SIGNED") return null;
  const contract = await prisma.skillContract.findUnique({ where: { id: row.skillContractId }, select: { id: true, contractHash: true } });
  if (!contract) return null;
  const signedPayload = buildWorkItemSignedPayload({
    studyId: row.studyId,
    requestedById: row.requestedById,
    contract,
    purpose: row.purpose,
    inputHash: row.inputHash,
    evidenceIds: row.evidenceIds,
    allowedTools: row.allowedTools,
    tokenBudget: row.tokenBudget,
    timeBudgetSeconds: row.timeBudgetSeconds,
    expiresAt: row.expiresAt
  });
  let expected: string;
  try {
    expected = signControlPayload(signedPayload);
  } catch {
    return null;
  }
  if (expected !== row.signature) return null;
  return { id: row.id, signature: row.signature, signedPayload };
}

/**
 * The bytes the orchestrator checks: the signed work item, and a signature that ties this exact request to it.
 * Exported for tests.
 */
export async function buildRespondBody(call: { workItemId?: string | null; studyId: string; body: Record<string, unknown> }) {
  if (!call.workItemId) throw new AssistantModelError("The assistant needs a safety check before it can answer, and none is available for this request.", "not_signed");
  let item: Awaited<ReturnType<typeof loadSignedWorkItem>>;
  try {
    item = await loadSignedWorkItem(call.workItemId, call.studyId);
  } catch {
    item = null;
  }
  if (!item) throw new AssistantModelError("The assistant needs a signed safety check before it can answer, and none is available for this request.", "not_signed");
  const requestHash = contentHash(call.body);
  const issuedAt = Date.now();
  const nonce = randomUUID();
  let signature: string;
  try {
    signature = signControlPayload({ kind: "model_request", workItemId: item.id, signedPayloadHash: contentHash(item.signedPayload), requestHash, issuedAt, nonce });
  } catch {
    throw new AssistantModelError("The assistant needs a signed safety check before it can answer, and none is available for this request.", "not_signed");
  }
  return {
    workItem: { id: item.id, signature: item.signature, signedPayload: item.signedPayload },
    binding: { requestHash, issuedAt, nonce, signature },
    request: call.body
  };
}

function asError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { message: code } }), { status, headers: { "content-type": "application/json" } });
}

/**
 * Sends one assistant model call. Resolves with a Response shaped like the provider's (raw Responses API JSON, or an SSE
 * body when stream is true), so callers keep their existing parsing. A non-ok status means the call failed upstream.
 * Throws AssistantModelError when the orchestrator route cannot be used (nothing is then sent anywhere).
 * Direct fetch failures (network, abort) reject exactly as before.
 */
export async function callAssistantModel(call: AssistantModelCall): Promise<Response> {
  const body = call.stream ? { ...call.request, stream: true } : call.request;
  if (assistantModelRoute() === "direct") {
    return fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${call.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: call.signal
    });
  }

  const payload = await buildRespondBody({ workItemId: call.workItemId, studyId: call.studyId, body });
  let response: Response;
  try {
    response = await orchestratorFetch("/v1/work-items/respond", payload, { signal: call.signal });
  } catch (error) {
    if (call.signal?.aborted) throw error;
    console.error("assistant-model: orchestrator unreachable", error instanceof Error ? error.message : "unknown");
    throw new AssistantModelError("The assistant service is not reachable. Try again shortly.", "unreachable");
  }
  if (call.stream) {
    if (response.ok && response.body) return response;
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    console.error("assistant-model: orchestrator refused the stream", response.status, failure?.error ?? "");
    return asError(response.ok ? 502 : response.status, failure?.error ?? "upstream_error");
  }
  const result = (await response.json().catch(() => null)) as { output?: unknown; execution?: unknown; error?: string } | null;
  if (!response.ok || !result || result.output === undefined) {
    console.error("assistant-model: orchestrator refused the call", response.status, result?.error ?? "");
    return asError(response.ok ? 502 : response.status, result?.error ?? "upstream_error");
  }
  // The raw provider body, so callers parse it the same way on both routes; usage is inside it.
  return new Response(JSON.stringify(result.output), { status: 200, headers: { "content-type": "application/json" } });
}
