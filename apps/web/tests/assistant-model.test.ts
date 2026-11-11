import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  workItem: null as Record<string, any> | null,
  contract: { id: "c1", contractHash: "ch" } as Record<string, any> | null,
  lookups: 0
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    workItem: { findUnique: async () => { h.lookups += 1; return h.workItem; } },
    skillContract: { findUnique: async () => h.contract }
  }
}));

import { callAssistantModel, buildRespondBody, usageOf } from "@/lib/assistant-model";
import { canonicalJson, contentHash, signControlPayload } from "@/lib/control-plane";
import { buildWorkItemSignedPayload } from "@/lib/control-plane-store";

const SECRET = ["unit", "signing", "secret", "value"].join("-");
const config = { apiKey: ["provider", "key"].join("-"), model: "gpt-4.1" };
const request = { model: "gpt-4.1", input: "hello", max_output_tokens: 4096, store: false };

function row(over: Record<string, any> = {}) {
  const base = { id: "wi1", studyId: "s1", skillContractId: "c1", requestedById: "u1", status: "SIGNED", controlState: "WORK_ITEM_SIGNED", purpose: "Assistant answer (read only)", inputHash: "a".repeat(64), evidenceIds: [], allowedTools: [], tokenBudget: 16000, timeBudgetSeconds: 180, expiresAt: null, signature: "" as string | null, ...over };
  if (over.signature === undefined) {
    const payload = buildWorkItemSignedPayload({ studyId: base.studyId, requestedById: base.requestedById, contract: { id: "c1", contractHash: "ch" }, purpose: base.purpose, inputHash: base.inputHash, evidenceIds: [], allowedTools: [], tokenBudget: 16000, timeBudgetSeconds: 180, expiresAt: null });
    base.signature = signControlPayload(payload);
  }
  return base;
}

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.FEDLIFY_CONTROL_SIGNING_SECRET = SECRET;
  process.env.FEDLIFY_ORCHESTRATOR_URL = "http://orchestrator.test";
  process.env.FEDLIFY_ORCHESTRATOR_TOKEN = ["orch", "token"].join("-");
  delete process.env.ASSISTANT_MODEL_ROUTE;
  h.workItem = row();
  h.contract = { id: "c1", contractHash: "ch" };
  h.lookups = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("callAssistantModel: direct route (default)", () => {
  it("sends the same bytes to the provider and never touches the orchestrator or the ledger", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await callAssistantModel({ config, studyId: "s1", request, stream: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.body).toBe(JSON.stringify(request));
    expect(init.headers.authorization).toBe(`Bearer ${config.apiKey}`);
    expect(h.lookups).toBe(0);
  });

  it("appends stream:true last for streaming calls", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await callAssistantModel({ config, studyId: "s1", request, stream: true });
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ...request, stream: true }));
  });

  it("works without any work item", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(callAssistantModel({ config, studyId: "s1", workItemId: null, request, stream: false })).resolves.toBeInstanceOf(Response);
  });

  it("treats an unknown route value as direct", async () => {
    process.env.ASSISTANT_MODEL_ROUTE = "something";
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await callAssistantModel({ config, studyId: "s1", request, stream: false });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
  });
});

describe("callAssistantModel: orchestrator route", () => {
  beforeEach(() => { process.env.ASSISTANT_MODEL_ROUTE = "orchestrator"; });

  it("signs the request binding and returns the raw provider body", async () => {
    const upstream = { status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 2 } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output: upstream, execution: { inputTokens: 4 } }), { status: 200 }));
    const response = await callAssistantModel({ config: { apiKey: "", model: "gpt-4.1" }, studyId: "s1", workItemId: "wi1", request, stream: false });
    expect(await response.json()).toEqual(upstream);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://orchestrator.test/v1/work-items/respond");
    expect(init.headers.authorization).toBe(`Bearer ${process.env.FEDLIFY_ORCHESTRATOR_TOKEN}`);
    const sent = JSON.parse(init.body);
    expect(sent.request).toEqual(request);
    expect(sent.workItem.id).toBe("wi1");
    expect(sent.binding.requestHash).toBe(contentHash(request));
    // The binding signature covers the request hash and the signed payload, and is verifiable with the shared secret.
    const expected = createHmac("sha256", SECRET).update(canonicalJson({ kind: "model_request", workItemId: "wi1", signedPayloadHash: contentHash(sent.workItem.signedPayload), requestHash: sent.binding.requestHash, issuedAt: sent.binding.issuedAt, nonce: sent.binding.nonce })).digest("hex");
    expect(sent.binding.signature).toBe(expected);
    expect(createHmac("sha256", SECRET).update(canonicalJson(sent.workItem.signedPayload)).digest("hex")).toBe(sent.workItem.signature);
    expect(sent.workItem.signedPayload).toMatchObject({ studyId: "s1", tokenBudget: 16000, timeBudgetSeconds: 180 });
    expect(usageOf(await new Response(JSON.stringify(upstream)).json())).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it("binds a different request to a different hash and nonce", async () => {
    const a = await buildRespondBody({ workItemId: "wi1", studyId: "s1", body: request });
    const b = await buildRespondBody({ workItemId: "wi1", studyId: "s1", body: { ...request, input: "other" } });
    expect(a.binding.requestHash).not.toBe(b.binding.requestHash);
    expect(a.binding.nonce).not.toBe(b.binding.nonce);
  });

  it.each([
    ["no work item", () => undefined, null],
    ["unknown work item", () => { h.workItem = null; }, "wi1"],
    ["unsigned work item (shadow)", () => { h.workItem = row({ signature: null, status: "DRAFT", controlState: "POLICY_AUTHORIZED" }); }, "wi1"],
    ["stopped work item", () => { h.workItem = row({ status: "FAILED", controlState: "STOPPED" }); }, "wi1"],
    ["tampered budget", () => { h.workItem = { ...row(), tokenBudget: 999999 }; }, "wi1"],
    ["another study", () => { h.workItem = row({ studyId: "s2" }); }, "wi1"]
  ])("fails closed with %s and sends nothing", async (_name, setup, workItemId) => {
    setup();
    await expect(callAssistantModel({ config, studyId: "s1", workItemId, request, stream: false })).rejects.toMatchObject({ name: "AssistantModelError", code: "not_signed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when signing is unavailable", async () => {
    delete process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    await expect(callAssistantModel({ config, studyId: "s1", workItemId: "wi1", request, stream: false })).rejects.toMatchObject({ code: "not_signed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to the provider when the orchestrator is down", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(callAssistantModel({ config, studyId: "s1", workItemId: "wi1", request, stream: false })).rejects.toMatchObject({ code: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("orchestrator.test");
  });

  it("turns an orchestrator refusal into a failed response with only a code", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "token_budget_exceeded" }), { status: 422 }));
    const response = await callAssistantModel({ config, studyId: "s1", workItemId: "wi1", request, stream: false });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { message: "token_budget_exceeded" } });
  });

  it("passes the stream through without buffering and propagates abort", async () => {
    const enc = new TextEncoder();
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
          seenSignal!.addEventListener("abort", () => controller.error(new Error("aborted")));
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const abort = new AbortController();
    const response = await callAssistantModel({ config, studyId: "s1", workItemId: "wi1", request, stream: true, signal: abort.signal });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).request.stream).toBe(true);
    const reader = response.body!.getReader();
    const first = await reader.read();
    // The first chunk is readable while the upstream is still open.
    expect(new TextDecoder().decode(first.value)).toContain("Hi");
    const pending = reader.read();
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(seenSignal?.aborted).toBe(true);
  });

  it("returns a failed response when the stream is refused", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "binding_expired" }), { status: 403 }));
    const response = await callAssistantModel({ config, studyId: "s1", workItemId: "wi1", request, stream: true });
    expect(response.ok).toBe(false);
    expect(response.body).not.toBeNull();
    expect(await response.json()).toEqual({ error: { message: "binding_expired" } });
  });
});
