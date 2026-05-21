import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { runTemplateAgentAssistant, type TemplateAgentIntake } from "@/lib/template-agent";

const sessionSchema = z.object({
  mode: z.enum(["FROM_PUBLIC_TEMPLATE", "FROM_STUDY_TEMPLATE", "FROM_SCRATCH"]),
  studyId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  intake: z.record(z.string(), z.unknown()).optional()
});

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const parsed = sessionSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template agent session.");

  if (parsed.data.studyId) {
    try {
      await assertStudyAccess(authResult.userId, parsed.data.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  }

  if (parsed.data.templateId) {
    const template = await prisma.pipelineTemplate.findUnique({ where: { id: parsed.data.templateId }, select: { scope: true, studyId: true } });
    if (!template) return problem(404, "Template was not found.", "template_not_found");
    if (template.scope === "STUDY_TEMPLATE" && template.studyId !== parsed.data.studyId) {
      return problem(404, "Study template was not found in this study workspace.", "template_not_found");
    }
  }

  const intake = (parsed.data.intake ?? {}) as TemplateAgentIntake;
  const assistant = await runTemplateAgentAssistant({
    mode: parsed.data.mode,
    intake,
    userMessage: "Start template agent session."
  });
  const now = new Date().toISOString();
  const session = await prisma.templateAgentSession.create({
    data: {
      studyId: parsed.data.studyId,
      templateId: parsed.data.templateId,
      requestedById: authResult.userId,
      mode: parsed.data.mode,
      status: assistant.missing.length > 0 ? "INTAKE" : "CODING",
      intake,
      messages: [
        {
          role: "assistant",
          content: assistant.message,
          createdAt: now,
          modelUsed: assistant.modelUsed,
          openAiUsed: assistant.openAiUsed,
          missing: assistant.missing
        }
      ]
    }
  });

  return json({ session, missing: assistant.missing }, { status: 201 });
}
