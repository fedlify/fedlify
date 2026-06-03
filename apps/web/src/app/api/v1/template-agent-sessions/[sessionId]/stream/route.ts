import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import { missingTemplateAgentFields, type AgentMessage, type TemplateAgentIntake } from "@/lib/template-agent";

const streamSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  intakePatch: z.record(z.string(), z.unknown()).optional()
});

type Params = { params: Promise<{ sessionId: string }> };

function asMessageList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item != null) : [];
}

// Build the system prompt inline (mirrors template-agent.ts SYSTEM_PROMPT)
const SYSTEM_PROMPT = [
  "You are Fedlify's NVFLARE pipeline development agent for health AI federated learning.",
  "You help research teams design and generate complete, runnable NVFLARE federated learning pipelines.",
  "",
  "## Your capabilities",
  "- Guide users through intake (clinical use case, data modalities, privacy constraints, aggregation strategy)",
  "- Generate complete Python code for SiteLocalExecutor including a real training loop",
  "- Generate NVFlare configuration files (server config, client config, meta.conf)",
  "- Explain federated learning concepts, FedAvg, differential privacy, and NVFlare APIs",
  "- Propose code changes when the user asks to adjust existing pipelines",
  "",
  "## Rules",
  "- Never commit raw clinical data, patient identifiers, extracts, or site-local dataset files",
  "- Keep site count, min_clients, num_rounds, and aggregation configurable via NVFlare conf files",
  "- Preserve repository shape: README.md, AGENTS.md, .fedlify/template.json, nvflare-job/, tests/",
  "- Never claim production approval or run production jobs",
  "- When generating executor code: produce complete, runnable Python — not pseudocode or placeholders"
].join("\n");

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const { sessionId } = await params;
  const parsed = streamSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid stream request.");

  const session = await prisma.templateAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return problem(404, "Template agent session was not found.", "not_found");

  if (session.requestedById !== authResult.userId && session.studyId) {
    try {
      await assertStudyAccess(authResult.userId, session.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, (error as Error).message, "forbidden");
      throw error;
    }
  } else if (session.requestedById !== authResult.userId) {
    return problem(403, "You do not have permission to use this template agent session.", "forbidden");
  }

  const config = openAiCodeAgentConfig();
  if (!config) {
    return problem(503, "AI code agent is not configured. Set OPENAI_API_KEY to enable streaming.", "ai_not_configured");
  }

  const intake = {
    ...((session.intake ?? {}) as TemplateAgentIntake),
    ...(parsed.data.intakePatch ?? {})
  } as TemplateAgentIntake;

  const missing = missingTemplateAgentFields(intake);

  const priorMessages = asMessageList(session.messages)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "") })) satisfies AgentMessage[];

  const inputMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...priorMessages.slice(-8),
    {
      role: "user",
      content: JSON.stringify(
        { mode: session.mode, intake, missing, userMessage: parsed.data.message },
        null,
        2
      )
    }
  ];

  // Call OpenAI with stream: true
  const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      input: inputMessages,
      max_output_tokens: 8192,
      stream: true
    })
  });

  if (!openAiResponse.ok || !openAiResponse.body) {
    const errorBody = await openAiResponse.json().catch(() => null) as { error?: { message?: string } } | null;
    return problem(502, `OpenAI stream failed: ${errorBody?.error?.message ?? openAiResponse.statusText}`, "upstream_error");
  }

  const now = new Date().toISOString();

  // Proxy the OpenAI stream to the client as SSE, accumulate full text, then persist
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    let accumulated = "";
    try {
      const reader = openAiResponse.body!.getReader();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;

          // Forward the raw SSE line to the client
          await writer.write(encoder.encode(`data: ${data}\n\n`));

          // Accumulate text delta for persistence
          try {
            const parsed = JSON.parse(data) as {
              type?: string;
              delta?: { text?: string };
              output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
            };
            // The Responses API sends delta as a plain string: {"type":"response.output_text.delta","delta":"text chunk"}
            if (parsed.type === "response.output_text.delta") {
              const chunk = typeof parsed.delta === "string" ? parsed.delta : (parsed.delta as any)?.text ?? "";
              accumulated += chunk;
            }
          } catch {
            // non-JSON line — ignore
          }
        }
      }

      // Persist the completed message to the session
      const fullMessage = accumulated.trim() || "(no response)";
      const updatedMessages = [
        ...asMessageList(session.messages),
        { role: "user", content: parsed.data.message, createdAt: now, intakePatch: parsed.data.intakePatch ?? null },
        {
          role: "assistant",
          content: fullMessage,
          createdAt: now,
          modelUsed: config.model,
          openAiUsed: true,
          missing
        }
      ] as Prisma.InputJsonValue;

      await prisma.templateAgentSession.update({
        where: { id: session.id },
        data: {
          intake,
          messages: updatedMessages,
          status: missing.length > 0 ? "INTAKE" : "CODING",
          resultSummary: fullMessage
        }
      });

      // Emit a final event with the persisted session ID so the client can refresh
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "fedlify.done", sessionId: session.id, missing })}\n\n`));
    } catch {
      // Stream errors are non-recoverable here; client will detect the closed stream
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no"
    }
  });
}
