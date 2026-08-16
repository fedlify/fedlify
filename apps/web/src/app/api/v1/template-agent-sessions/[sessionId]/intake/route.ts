import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { applyTemplateAgentIntakePatch, type TemplateAgentIntake } from "@/lib/template-agent";

const intakeSchema = z.object({
  intakePatch: z.record(z.string(), z.unknown())
});

type Params = { params: Promise<{ sessionId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const { sessionId } = await params;
  const parsed = intakeSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid intake patch.");

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

  const intakeState = applyTemplateAgentIntakePatch((session.intake ?? {}) as TemplateAgentIntake, parsed.data.intakePatch);
  const updated = await prisma.templateAgentSession.update({
    where: { id: session.id },
    data: {
      intake: intakeState.intake,
      status: intakeState.status
    }
  });

  return json({
    session: updated,
    missing: intakeState.missing,
    guardrailFindings: intakeState.guardrailFindings,
    nextSkill: intakeState.nextSkill
  });
}
