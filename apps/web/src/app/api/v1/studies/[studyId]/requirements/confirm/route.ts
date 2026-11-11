/**
 * POST { ackAssumptions? }: "Confirm study specification".
 *
 * Allowed only when all 29 questions are ANSWERED or ASSUMED. When any are assumptions, the request must carry
 * ackAssumptions: true; without it the response (409 assumptions_not_acknowledged) lists them so the person can read
 * them back first. A confirmation stores who, when and a hash over the ordered answers on the study, writes a
 * DecisionRecord (hashes and counts only) and an audit event. Any later change to an answer clears it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { REQUIREMENT_ORDER, REQUIREMENTS } from "@/lib/requirements-catalog";
import { PLAIN_QUESTIONS, rowStatus, specificationHash } from "@/lib/study-questions";
import { loadQuestionRows } from "@/lib/study-questions-store";

const bodySchema = z.object({ ackAssumptions: z.boolean().optional() });

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;
  const userId = authResult.userId;

  try {
    await assertStudyAccess(userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, "Invalid request.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true, specificationConfirmedAt: true, specificationHash: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const rows = await loadQuestionRows(studyId);
  const byId = new Map(rows.map((row) => [row.requirementId, row]));
  const open = REQUIREMENT_ORDER.filter((id) => {
    const status = rowStatus(byId.get(id));
    return status !== "ANSWERED" && status !== "ASSUMED";
  });
  if (open.length > 0) {
    return json(
      { error: { code: "questions_open", message: `${open.length} study ${open.length === 1 ? "question still needs" : "questions still need"} an answer from you before the study specification can be confirmed.` }, open },
      { status: 409 }
    );
  }

  const assumptions = REQUIREMENT_ORDER.filter((id) => rowStatus(byId.get(id)) === "ASSUMED").map((id) => ({ id, title: REQUIREMENTS[id].title, question: PLAIN_QUESTIONS[id], answer: byId.get(id)!.answer }));
  if (assumptions.length > 0 && parsed.data.ackAssumptions !== true) {
    return json(
      { error: { code: "assumptions_not_acknowledged", message: `${assumptions.length} ${assumptions.length === 1 ? "answer is an assumption" : "answers are assumptions"}. Read ${assumptions.length === 1 ? "it" : "them"} and confirm that you accept ${assumptions.length === 1 ? "it" : "them"}.` }, assumptions },
      { status: 409 }
    );
  }

  const hash = specificationHash(rows);
  const counts = { total: REQUIREMENT_ORDER.length, assumed: assumptions.length, answered: REQUIREMENT_ORDER.length - assumptions.length };
  const names = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const confirmedByName = names?.name?.trim() || names?.email || "You";

  if (study.specificationConfirmedAt && study.specificationHash === hash) {
    return json({ confirmed: true, alreadyConfirmed: true, confirmedAt: study.specificationConfirmedAt, specificationHash: hash, assumptions, counts });
  }

  const confirmedAt = new Date();
  const decision = { specificationHash: hash, ...counts, assumedIds: assumptions.map((item) => item.id), acknowledgedAssumptions: assumptions.length > 0 };
  await prisma.$transaction([
    prisma.study.update({ where: { id: studyId }, data: { specificationConfirmedAt: confirmedAt, specificationConfirmedById: userId, specificationHash: hash } }),
    prisma.decisionRecord.create({
      data: {
        studyId,
        decisionType: "STUDY_SPECIFICATION_CONFIRMED",
        decision,
        rationale: "A person confirmed the study specification.",
        evidenceIds: [],
        artifactIds: [],
        decisionHash: sha256(JSON.stringify({ studyId, type: "STUDY_SPECIFICATION_CONFIRMED", hash, userId, at: confirmedAt.toISOString() })),
        decidedById: userId
      }
    })
  ]);
  await audit({
    actorUserId: userId,
    orgId: study.orgId,
    studyId,
    action: "study.specification.confirm",
    targetType: "Study",
    targetId: studyId,
    metadata: { specificationHash: hash, ...counts },
    request
  });
  return json({ confirmed: true, confirmedAt, confirmedBy: { id: userId, name: confirmedByName }, specificationHash: hash, assumptions, counts });
}
