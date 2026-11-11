/**
 * POST /v1/work-items/respond
 *
 * The assistant's model calls, moved behind the orchestrator. The web app still builds the prompt; this service
 * checks that the call is the one the control plane signed, then forwards it unchanged to the Responses API.
 *
 * Request body:
 *   workItem: { id, signature, signedPayload }   signedPayload is exactly what the web control plane signed
 *   binding:  { requestHash, issuedAt, nonce, signature }
 *             signature = HMAC over { kind: "model_request", workItemId, signedPayloadHash, requestHash, issuedAt, nonce }
 *   request:  the exact Responses API body (model, input, max_output_tokens, store:false, stream?, text?, instructions?)
 *
 * Everything that limits the call (study, token budget, time budget, expiry) is read from signedPayload only.
 * Nothing is taken from unsigned outer fields.
 */
import { z } from "zod";
import { hash, verifySignature } from "./contracts.js";

export type RespondEnv = Record<string, string | undefined>;
export type RespondDeps = { fetch?: typeof fetch; env?: RespondEnv; now?: () => number };

export type RespondResult =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "stream"; status: 200; chunks: AsyncGenerator<Uint8Array, void, void> };

const DEFAULT_UPSTREAM = "https://api.openai.com/v1/responses";
const ALLOWED_REQUEST_KEYS = new Set(["model", "input", "instructions", "max_output_tokens", "store", "stream", "text"]);

const signedPayloadSchema = z.object({
  studyId: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/i),
  tokenBudget: z.number().int().positive(),
  timeBudgetSeconds: z.number().int().positive(),
  expiresAt: z.string().nullable().optional()
}).passthrough();

const bodySchema = z.object({
  workItem: z.object({ id: z.string().min(1), signature: z.string().regex(/^[a-f0-9]{64}$/i), signedPayload: z.unknown() }),
  binding: z.object({
    requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
    issuedAt: z.number().int().positive(),
    nonce: z.string().min(8).max(100),
    signature: z.string().regex(/^[a-f0-9]{64}$/i)
  }),
  request: z.record(z.string(), z.unknown())
});

/**
 * Binding nonces already used, and what each work item has spent. Both live in this process only: run ONE orchestrator
 * replica for respond traffic (the deploy manifest pins replicas: 1), or move these two maps to a shared store first.
 * The binding lifetime (default 60 s) bounds how long a nonce entry matters.
 */
const seenNonces = new Map<string, number>();
const MAX_NONCES = 50_000;
let lastNonceSweep = 0;

type Spend = { tokens: number; calls: number; at: number };
const spend = new Map<string, Spend>();
const MAX_LEDGER_ENTRIES = 20_000;
const LEDGER_KEEP_MS = 3_600_000;

export function resetRespondState() {
  seenNonces.clear();
  spend.clear();
  lastNonceSweep = 0;
}

/** Upper estimate of the input tokens of a request: JSON bytes / 3 (English text is nearer 4, so this over-counts). */
export function estimateInputTokens(request: Record<string, unknown>): number {
  const { input, instructions, text } = request;
  return Math.ceil(Buffer.byteLength(JSON.stringify({ input, instructions, text }), "utf8") / 3);
}

function reject(status: number, error: string): RespondResult {
  return { kind: "json", status, body: { error } };
}

export function respondLimits(env: RespondEnv = process.env) {
  return {
    maxBodyBytes: Math.max(100_000, Number(env.FEDLIFY_RESPOND_MAX_BODY ?? 8_000_000) || 8_000_000)
  };
}

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

function usageOf(body: unknown): Usage {
  const usage = (body && typeof body === "object" ? (body as { usage?: Record<string, unknown> }).usage : undefined) ?? {};
  const input = Number(usage.input_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? 0) || 0;
  return { inputTokens: input, outputTokens: output, totalTokens: Number(usage.total_tokens ?? input + output) || input + output };
}

function outputTextOf(body: unknown): string {
  let text = "";
  const output = body && typeof body === "object" ? (body as { output?: unknown }).output : undefined;
  for (const item of Array.isArray(output) ? output : []) {
    const content = item && typeof item === "object" ? (item as { content?: unknown }).content : undefined;
    for (const part of Array.isArray(content) ? content : []) {
      const piece = part as { type?: string; text?: string };
      if (piece?.type === "output_text" && typeof piece.text === "string") text += piece.text;
    }
  }
  return text;
}

/**
 * Verifies and runs one call. `clientSignal` aborts the upstream call when the web app disconnects.
 * Never includes provider error text in a result: the reason goes to the log only.
 */
export async function handleRespond(rawBody: unknown, deps: RespondDeps = {}, clientSignal?: AbortSignal): Promise<RespondResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return reject(422, "respond_body_invalid");
  const { workItem, binding, request } = parsed.data;

  // (a) the work item signature, over the payload exactly as the control plane signed it
  if (!verifySignature(workItem.signedPayload, workItem.signature)) return reject(403, "work_item_signature_invalid");
  const payloadResult = signedPayloadSchema.safeParse(workItem.signedPayload);
  if (!payloadResult.success) return reject(403, "work_item_payload_invalid");
  const payload = payloadResult.data;
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= now()) return reject(403, "work_item_expired");

  // (b) the binding of this exact request to this work item, short lived and single use
  const bindingPayload = {
    kind: "model_request",
    workItemId: workItem.id,
    signedPayloadHash: hash(workItem.signedPayload),
    requestHash: binding.requestHash,
    issuedAt: binding.issuedAt,
    nonce: binding.nonce
  };
  if (!verifySignature(bindingPayload, binding.signature)) return reject(403, "binding_signature_invalid");
  const ttlMs = Math.max(10, Number(env.FEDLIFY_RESPOND_BINDING_TTL_SECONDS ?? 60) || 60) * 1000;
  const age = now() - binding.issuedAt;
  if (age > ttlMs || age < -30_000) return reject(403, "binding_expired");
  if (now() - lastNonceSweep > 5_000 || seenNonces.size >= MAX_NONCES) {
    lastNonceSweep = now();
    for (const [key, at] of seenNonces) if (now() - at > ttlMs * 2) seenNonces.delete(key);
  }
  if (seenNonces.has(binding.nonce)) return reject(403, "binding_replayed");
  if (seenNonces.size >= MAX_NONCES) return reject(503, "replay_store_full");

  // (c) the request is the one that was bound
  if (hash(request) !== binding.requestHash.toLowerCase()) return reject(403, "request_hash_mismatch");
  seenNonces.set(binding.nonce, now());

  // (d) the request itself must stay inside the contract: known keys only, no tools, no stored responses
  for (const key of Object.keys(request)) if (!ALLOWED_REQUEST_KEYS.has(key)) return reject(422, "request_field_not_allowed");
  if (request.store !== false) return reject(422, "request_must_not_store");
  const model = request.model;
  const allowed = (env.FEDLIFY_RESPOND_MODELS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (typeof model !== "string" || !allowed.includes(model)) return reject(422, "model_not_allowed");
  const maxOutput = request.max_output_tokens;
  if (typeof maxOutput !== "number" || !Number.isInteger(maxOutput) || maxOutput <= 0) return reject(422, "max_output_tokens_required");
  if (maxOutput > payload.tokenBudget) return reject(422, "token_budget_exceeded");
  // The signed tokenBudget covers input + output of ALL calls made for this work item, not one call.
  const reserve = estimateInputTokens(request) + maxOutput;
  const maxCalls = Math.max(1, Number(env.FEDLIFY_RESPOND_MAX_CALLS ?? 6) || 6);
  for (const [key, entry] of spend) if (now() - entry.at > LEDGER_KEEP_MS) spend.delete(key);
  let ledger = spend.get(workItem.id);
  if (!ledger) {
    if (spend.size >= MAX_LEDGER_ENTRIES) return reject(503, "budget_store_full");
    ledger = { tokens: 0, calls: 0, at: now() };
    spend.set(workItem.id, ledger);
  }
  if (ledger.calls >= maxCalls) return reject(422, "call_budget_exceeded");
  if (ledger.tokens + reserve > payload.tokenBudget) return reject(422, "token_budget_exceeded");
  const stream = request.stream === true;
  if (request.stream !== undefined && typeof request.stream !== "boolean") return reject(422, "request_field_not_allowed");

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return reject(503, "model_provider_not_configured");

  // Reserve now, settle with the real usage afterwards. Audit line carries ids only, never content.
  ledger.calls += 1;
  ledger.tokens += reserve;
  ledger.at = now();
  const settle = (actual: number) => {
    if (actual > 0) ledger!.tokens += actual - reserve;
  };
  console.log(JSON.stringify({ event: "respond", workItemId: workItem.id, studyId: payload.studyId, model, stream, reserveTokens: reserve, call: ledger.calls }));

  // Budgets come from the signed payload; the service ceiling can only shorten them.
  const ceilingMs = Number(env.FEDLIFY_RESPOND_MAX_MS ?? 300_000) || 300_000;
  const timeoutMs = Math.min(payload.timeBudgetSeconds * 1000, ceilingMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("time_budget_exceeded")), timeoutMs);
  const onClientAbort = () => controller.abort(new Error("client_closed"));
  if (clientSignal?.aborted) onClientAbort();
  else clientSignal?.addEventListener("abort", onClientAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener("abort", onClientAbort);
  };

  const timedOut = () => controller.signal.aborted && String(controller.signal.reason?.message) === "time_budget_exceeded";
  const started = now();
  let upstream: Response;
  try {
    upstream = await doFetch(env.FEDLIFY_RESPOND_UPSTREAM_URL ?? DEFAULT_UPSTREAM, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal
    });
  } catch (error) {
    cleanup();
    console.error("respond: upstream request failed", error instanceof Error ? error.message : "unknown");
    return reject(timedOut() ? 504 : 502, "upstream_error");
  }

  const execution = (usage: Usage, outputHash: string, stopReason: string) => ({
    workItemId: workItem.id,
    role: "WORKER",
    provider: "openai",
    model,
    promptHash: binding.requestHash.toLowerCase(),
    outputHash,
    stopReason,
    ...usage,
    requests: 1,
    durationMs: Math.max(0, now() - started)
  });

  if (!stream) {
    try {
      const output = (await upstream.json().catch(() => null)) as unknown;
      if (!upstream.ok) {
        console.error("respond: upstream status", upstream.status);
        return reject(timedOut() ? 504 : 502, "upstream_error");
      }
      if (output === null) return reject(timedOut() ? 504 : 502, "upstream_error");
      settle(usageOf(output).totalTokens);
      const status = typeof (output as { status?: unknown } | null)?.status === "string" ? String((output as { status: string }).status) : "completed";
      return { kind: "json", status: 200, body: { output, execution: execution(usageOf(output), hash(output), status) } };
    } finally {
      cleanup();
    }
  }

  if (!upstream.ok || !upstream.body) {
    cleanup();
    console.error("respond: upstream status", upstream.status);
    return reject(502, "upstream_error");
  }
  const upstreamBody = upstream.body;

  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    const reader = upstreamBody.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let text = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let stopReason = "stream_ended";
    const scan = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      try {
        const event = JSON.parse(trimmed.slice(5).trim()) as { type?: string; delta?: string; response?: unknown };
        if (event.type === "response.output_text.delta" && typeof event.delta === "string" && text.length < 2_000_000) text += event.delta;
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          usage = usageOf(event.response);
          stopReason = event.type === "response.completed" ? "completed" : "incomplete";
        }
      } catch {
        // not JSON: forwarded as is, ignored for accounting
      }
    };
    controller.signal.addEventListener("abort", () => { reader.cancel().catch(() => undefined); }, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value; // forwarded as it arrives: nothing is buffered here
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(scan);
      }
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason?.message ?? "aborted"));
      scan(buffer);
      settle(usage.totalTokens);
      yield encoder.encode(`data: ${JSON.stringify({ type: "fedlify.usage", execution: execution(usage, hash(text), stopReason) })}\n\n`);
    } catch (error) {
      const reason = String(controller.signal.reason?.message ?? "");
      console.error("respond: stream interrupted", error instanceof Error ? error.message : "unknown");
      if (reason !== "client_closed") {
        yield encoder.encode(`data: ${JSON.stringify({ type: "error", message: reason === "time_budget_exceeded" ? "time_budget_exceeded" : "upstream_interrupted" })}\n\n`);
      }
    } finally {
      cleanup();
      controller.abort(new Error("client_closed"));
      reader.cancel().catch(() => undefined);
    }
  }
  return { kind: "stream", status: 200, chunks: chunks() };
}
