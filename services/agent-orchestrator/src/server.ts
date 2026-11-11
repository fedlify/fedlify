import { createServer } from "node:http";
import { executeCodexWorkItem } from "./codex-worker.js";
import { analyzeIntake, executeWorkItem, verifyProposal } from "./orchestrator.js";
import { preflightProvider } from "./providers.js";
import { bearerAuthorized } from "./auth.js";
import { handleRespond, respondLimits } from "./respond.js";

type PreflightState = { status: "checking" | "available" | "unavailable"; checkedAt?: string; profile?: unknown; error?: string };
let hostedPreflight: PreflightState = { status: "checking" };

async function refreshHostedPreflight() {
  try {
    const result = await preflightProvider("hosted");
    hostedPreflight = { status: "available", checkedAt: new Date().toISOString(), profile: result };
  } catch (error) {
    hostedPreflight = {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "provider_preflight_failed"
    };
  }
  return hostedPreflight;
}

async function readBody(request: import("node:http").IncomingMessage, limit = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`Request body exceeds ${Math.round(limit / 1_000_000)} MB.`);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: import("node:http").IncomingMessage): boolean {
  return bearerAuthorized(request.headers.authorization, process.env.FEDLIFY_ORCHESTRATOR_TOKEN);
}

async function serveRespond(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  const abort = new AbortController();
  response.on("close", () => { if (!response.writableFinished) abort.abort(); });
  try {
    const body = await readBody(request, respondLimits().maxBodyBytes);
    const result = await handleRespond(body, {}, abort.signal);
    if (result.kind === "json") {
      response.statusCode = result.status;
      return response.end(JSON.stringify(result.body));
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    for await (const chunk of result.chunks) {
      if (response.destroyed) break;
      response.write(chunk);
    }
    response.end();
  } catch (error) {
    if (response.headersSent) return response.end();
    response.statusCode = 422;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "execution_failed" }));
  }
}

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.statusCode = 200;
    return response.end(JSON.stringify({ status: "ok" }));
  }
  if (request.url === "/ready") {
    response.statusCode = hostedPreflight.status === "unavailable" ? 503 : 200;
    return response.end(JSON.stringify({
      status: hostedPreflight.status === "available" ? "ready" : "not_ready",
      hostedProvider: { status: hostedPreflight.status, checkedAt: hostedPreflight.checkedAt }
    }));
  }
  const isAuthorized = authorized(request);
  if (request.method !== "POST" || !isAuthorized) {
    response.statusCode = isAuthorized ? 404 : 401;
    return response.end(JSON.stringify({ error: "unauthorized_or_not_found" }));
  }
  if (request.url === "/v1/work-items/respond") return serveRespond(request, response);
  try {
    const body = await readBody(request) as Record<string, unknown>;
    const profile = typeof body.profile === "string" ? body.profile : "hosted";
    let result: unknown;
    if (request.url === "/v1/providers/preflight") result = profile === "hosted" ? await refreshHostedPreflight() : await preflightProvider(profile);
    else if (request.url === "/v1/work-items/execute") result = await executeWorkItem(body.workItem, profile);
    else if (request.url === "/v1/work-items/verify") result = await verifyProposal(body.workItem, body.proposal, profile);
    else if (request.url === "/v1/work-items/codex") result = await executeCodexWorkItem(body.workItem, String(body.sourceRepository ?? ""));
    else if (request.url === "/v1/intake/analyze") result = await analyzeIntake(body.intake, profile);
    else if (request.url === "/v1/probes/route") { response.statusCode = 410; return response.end(JSON.stringify({ error: "model_directed_probe_routing_removed" })); }
    else { response.statusCode = 404; return response.end(JSON.stringify({ error: "not_found" })); }
    response.statusCode = 200;
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode = 422;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "execution_failed" }));
  }
});

server.listen(Number(process.env.PORT ?? 3020), "0.0.0.0");
void refreshHostedPreflight();
