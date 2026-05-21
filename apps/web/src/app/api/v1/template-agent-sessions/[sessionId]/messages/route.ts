import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { runTemplateAgentAssistant, type TemplateAgentIntake } from "@/lib/template-agent";

const messageSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  intakePatch: z.record(z.string(), z.unknown()).optional()
});

type Params = { params: Promise<{ sessionId: string }> };

function asMessageList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item != null) : [];
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;
  const parsed = messageSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template agent message.");

  const session = await prisma.templateAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return problem(404, "Template agent session was not found.", "not_found");
  if (session.requestedById !== authResult.userId && session.studyId) {
    try {
      await assertStudyAccess(authResult.userId, session.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  } else if (session.requestedById !== authResult.userId) {
    return problem(403, "You do not have permission to use this template agent session.", "forbidden");
  }

  const intake = {
    ...((session.intake ?? {}) as TemplateAgentIntake),
    ...(parsed.data.intakePatch ?? {})
  } as TemplateAgentIntake;
  const assistant = await runTemplateAgentAssistant({
    mode: session.mode,
    intake,
    userMessage: parsed.data.message
  });
  const now = new Date().toISOString();
  const messages = [
    ...asMessageList(session.messages),
    { role: "user", content: parsed.data.message, createdAt: now, intakePatch: parsed.data.intakePatch ?? null },
    {
      role: "assistant",
      content: assistant.message,
      createdAt: now,
      modelUsed: assistant.modelUsed,
      openAiUsed: assistant.openAiUsed,
      missing: assistant.missing
    }
  ] as Prisma.InputJsonValue;

  const updated = await prisma.templateAgentSession.update({
    where: { id: session.id },
    data: {
      intake,
      messages,
      status: assistant.missing.length > 0 ? "INTAKE" : "CODING",
      resultSummary: assistant.message
    }
  });

  return json({ session: updated, missing: assistant.missing });
}
