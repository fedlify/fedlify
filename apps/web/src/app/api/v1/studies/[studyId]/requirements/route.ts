import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requirementsGate } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { REQUIREMENTS, REQUIREMENT_ORDER, type RequirementId } from "@/lib/requirements-catalog";

const requirementIdSchema = z.enum(REQUIREMENT_ORDER as [RequirementId, ...RequirementId[]]);

const answerSchema = z.object({
  requirementId: requirementIdSchema,
  answer: z.string().trim().min(1).max(4000)
});

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const responses = await prisma.requirementResponse.findMany({ where: { studyId } });
  const byId = new Map(responses.map((response) => [response.requirementId, response]));
  const gate = requirementsGate(responses);

  const requirements = REQUIREMENT_ORDER.map((id) => ({
    ...REQUIREMENTS[id],
    response: byId.get(id) ?? null
  }));

  return json({ requirements, answeredCount: responses.length, totalCount: REQUIREMENT_ORDER.length, missing: gate.missing, allowed: gate.allowed });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = answerSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid requirement answer.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const response = await prisma.requirementResponse.upsert({
    where: { studyId_requirementId: { studyId, requirementId: parsed.data.requirementId } },
    create: { studyId, requirementId: parsed.data.requirementId, answer: parsed.data.answer, respondedById: authResult.userId },
    update: { answer: parsed.data.answer, respondedById: authResult.userId }
  });

  const responses = await prisma.requirementResponse.findMany({ where: { studyId } });
  const gate = requirementsGate(responses);

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "study.requirement.answer",
    targetType: "RequirementResponse",
    targetId: response.id,
    metadata: { requirementId: parsed.data.requirementId },
    request
  });

  return json({ response, answeredCount: responses.length, totalCount: REQUIREMENT_ORDER.length, missing: gate.missing, allowed: gate.allowed });
}
