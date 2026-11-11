import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "./contracts.js";
import { handleRespond, resetRespondState } from "./respond.js";

const SECRET = ["unit", "test", "signing", "key"].join("-");
process.env.FEDLIFY_CONTROL_SIGNING_SECRET = SECRET;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const sign = (value: unknown) => createHmac("sha256", SECRET).update(canonical(value)).digest("hex");

const NOW = 1_800_000_000_000;
const env = { OPENAI_API_KEY: ["fake", "provider", "key"].join("-"), FEDLIFY_RESPOND_MODELS: "gpt-4.1,other", FEDLIFY_RESPOND_MAX_MS: "300000" };
const signedPayload = { studyId: "s1", skillContractId: "c1", contractHash: "h", requestedById: "u1", purpose: "p", inputHash: "a".repeat(64), evidenceIds: [], allowedTools: [], tokenBudget: 16000, timeBudgetSeconds: 180, expiresAt: null };
const baseRequest = { model: "gpt-4.1", input: "hello", max_output_tokens: 4096, store: false };

let nonceCounter = 0;
function build(request: Record<string, unknown> = baseRequest, over: { payload?: Record<string, unknown>; requestHash?: string; issuedAt?: number; nonce?: string } = {}) {
  const payload = { ...signedPayload, ...(over.payload ?? {}) };
  const requestHash = over.requestHash ?? hash(request);
  const issuedAt = over.issuedAt ?? NOW;
  const nonce = over.nonce ?? `nonce-${++nonceCounter}-xxxxxxxx`;
  const binding = { requestHash, issuedAt, nonce, signature: sign({ kind: "model_request", workItemId: "w1", signedPayloadHash: hash(payload), requestHash, issuedAt, nonce }) };
  return { workItem: { id: "w1", signature: sign(payload), signedPayload: payload }, binding, request };
}

const upstreamJson = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
const jsonFetch = () => vi.fn(async () => new Response(JSON.stringify(upstreamJson), { status: 200 })) as unknown as typeof fetch;
const deps = (f: typeof fetch) => ({ fetch: f, env, now: () => NOW });

beforeEach(() => resetRespondState());

describe("/v1/work-items/respond", () => {
  it("returns the raw upstream body plus an execution record with usage", async () => {
    const f = jsonFetch();
    const result = await handleRespond(build(), deps(f));
    expect(result.kind).toBe("json");
    if (result.kind !== "json") return;
    expect(result.status).toBe(200);
    const body = result.body as { output: unknown; execution: Record<string, unknown> };
    expect(body.output).toEqual(upstreamJson);
    expect(body.execution).toMatchObject({ workItemId: "w1", role: "WORKER", model: "gpt-4.1", inputTokens: 10, outputTokens: 5, totalTokens: 15, stopReason: "completed" });
    const call = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(JSON.parse(String(call[1].body))).toEqual(baseRequest);
  });

  it("rejects a bad work item signature and never calls the model", async () => {
    const f = jsonFetch();
    const input = build();
    input.workItem.signature = "0".repeat(64);
    const result = await handleRespond(input, deps(f));
    expect(result).toMatchObject({ kind: "json", status: 403, body: { error: "work_item_signature_invalid" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a payload that was altered after signing", async () => {
    const f = jsonFetch();
    const input = build();
    (input.workItem.signedPayload as Record<string, unknown>).tokenBudget = 999999;
    expect(await handleRespond(input, deps(f))).toMatchObject({ status: 403, body: { error: "work_item_signature_invalid" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a swapped request (hash mismatch)", async () => {
    const f = jsonFetch();
    const input = build();
    input.request = { ...baseRequest, input: "something else" };
    expect(await handleRespond(input, deps(f))).toMatchObject({ status: 403, body: { error: "request_hash_mismatch" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a binding signed for a different request hash", async () => {
    const f = jsonFetch();
    const input = build();
    const other = { ...baseRequest, input: "x" };
    input.request = other;
    input.binding.requestHash = hash(other);
    expect(await handleRespond(input, deps(f))).toMatchObject({ status: 403, body: { error: "binding_signature_invalid" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects an expired and a replayed binding", async () => {
    const f = jsonFetch();
    expect(await handleRespond(build(baseRequest, { issuedAt: NOW - 3_600_000 }), deps(f))).toMatchObject({ status: 403, body: { error: "binding_expired" } });
    const input = build();
    expect((await handleRespond(input, deps(f))).kind).toBe("json");
    expect(await handleRespond(input, deps(f))).toMatchObject({ status: 403, body: { error: "binding_replayed" } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("enforces the token budget from the signed payload", async () => {
    const f = jsonFetch();
    const big = { ...baseRequest, max_output_tokens: 20000 };
    expect(await handleRespond(build(big), deps(f))).toMatchObject({ status: 422, body: { error: "token_budget_exceeded" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects models off the allowlist, tools, and stored responses", async () => {
    const f = jsonFetch();
    expect(await handleRespond(build({ ...baseRequest, model: "gpt-9" }), deps(f))).toMatchObject({ status: 422, body: { error: "model_not_allowed" } });
    expect(await handleRespond(build({ ...baseRequest, tools: [] }), deps(f))).toMatchObject({ status: 422, body: { error: "request_field_not_allowed" } });
    expect(await handleRespond(build({ ...baseRequest, store: true }), deps(f))).toMatchObject({ status: 422, body: { error: "request_must_not_store" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("applies the signed time budget to the upstream call", async () => {
    let seen: AbortSignal | undefined;
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => seen!.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    const pending = handleRespond(build(baseRequest, { payload: { timeBudgetSeconds: 2 } }), deps(f));
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;
    vi.useRealTimers();
    expect(result).toMatchObject({ kind: "json", status: 504, body: { error: "upstream_error" } });
  });

  it("does not leak provider error text", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "secret provider detail" } }), { status: 500 })) as unknown as typeof fetch;
    const result = await handleRespond(build(), deps(f));
    expect(JSON.stringify(result)).not.toContain("secret provider detail");
    expect(result).toMatchObject({ status: 502, body: { error: "upstream_error" } });
  });

  it("streams chunks as they arrive and appends a usage event", async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'));
        await gate;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`));
        controller.close();
      }
    });
    const f = vi.fn(async () => new Response(upstream, { status: 200 })) as unknown as typeof fetch;
    const result = await handleRespond(build({ ...baseRequest, stream: true }), deps(f));
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const first = await result.chunks.next();
    // The first token arrives while the upstream is still open: nothing is buffered.
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain("Hel");
    release();
    let rest = "";
    for await (const chunk of result.chunks) rest += new TextDecoder().decode(chunk);
    expect(rest).toContain("response.completed");
    const usageLine = rest.split("\n").find((line) => line.includes("fedlify.usage"))!;
    const usage = JSON.parse(usageLine.slice(5));
    expect(usage.execution).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10, stopReason: "completed" });
  });

  it("aborts the upstream stream when the consumer or the client goes away", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel() { /* closed */ } });
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => { upstreamSignal = init?.signal as AbortSignal; return new Response(upstream, { status: 200 }); }) as unknown as typeof fetch;
    const client = new AbortController();
    const result = await handleRespond(build({ ...baseRequest, stream: true }), deps(f), client.signal);
    if (result.kind !== "stream") throw new Error("expected a stream");
    const next = result.chunks.next();
    client.abort();
    await next;
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("counts the input against the signed token budget", async () => {
    const f = jsonFetch();
    // ~60000 bytes of input is about 20000 estimated tokens, over the 16000 budget even with a small output cap
    const big = { ...baseRequest, input: "x".repeat(60_000), max_output_tokens: 1000 };
    expect(await handleRespond(build(big), deps(f))).toMatchObject({ status: 422, body: { error: "token_budget_exceeded" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("sums usage across calls of one work item and refuses past the signed budget", async () => {
    const f = jsonFetch();
    const req = { ...baseRequest, max_output_tokens: 6000 }; // reserves ~6000 each; the real usage is only 15 tokens
    expect((await handleRespond(build(req), deps(f))).kind).toBe("json");
    expect((await handleRespond(build(req), deps(f))).kind).toBe("json");
    // settled at real usage (15 tokens each), so the budget is still open
    expect(await handleRespond(build(req), deps(f))).toMatchObject({ status: 200 });
    // a request that reserves more than what is left is refused
    const huge = { ...baseRequest, max_output_tokens: 16000 };
    expect(await handleRespond(build(huge), deps(f))).toMatchObject({ status: 422, body: { error: "token_budget_exceeded" } });
  });

  it("caps the number of calls per work item", async () => {
    const f = jsonFetch();
    const limited = { ...deps(f), env: { ...env, FEDLIFY_RESPOND_MAX_CALLS: "2" } };
    expect((await handleRespond(build(), limited)).kind).toBe("json");
    expect((await handleRespond(build(), limited)).kind).toBe("json");
    expect(await handleRespond(build(), limited)).toMatchObject({ status: 422, body: { error: "call_budget_exceeded" } });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a slow body read after the time budget is a 504, not a 502", async () => {
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) } as unknown as Response;
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    const pending = handleRespond(build(baseRequest, { payload: { timeBudgetSeconds: 2 } }), deps(f));
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;
    vi.useRealTimers();
    expect(result).toMatchObject({ status: 504, body: { error: "upstream_error" } });
  });

  it("uses a 60 second binding lifetime by default", async () => {
    const f = jsonFetch();
    expect(await handleRespond(build(baseRequest, { issuedAt: NOW - 90_000 }), deps(f))).toMatchObject({ status: 403, body: { error: "binding_expired" } });
  });
});
