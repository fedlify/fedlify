import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { REQUIREMENT_ORDER, type RequirementId } from "@/lib/requirements-catalog";
import { ANSWER_MAX, isRequirementId } from "@/lib/study-questions";
import { clearSpecificationConfirmation, loadChecklist, loadQuestionRows } from "@/lib/study-questions-store";

const requirementIdSchema = z.enum(REQUIREMENT_ORDER as [RequirementId, ...RequirementId[]]);
const answerText = z.string().trim().min(1, "Write an answer first.").max(ANSWER_MAX, `Keep the answer under ${ANSWER_MAX} characters.`);

// "save" is the original body ({ requirementId, answer }) and stays the default when there is no action.
const bodySchema = z.union([
  // `seen` is what the person was looking at: when the stored suggestion has changed since, nothing is accepted (409).
  z.object({ action: z.literal("acceptAll"), seen: z.array(z.object({ requirementId: requirementIdSchema, answer: z.string() })).max(29).optional() }),
  z.object({ action: z.enum(["accept", "assume", "unknown"]), requirementId: requirementIdSchema, answer: answerText.optional(), seenAnswer: z.string().optional() }),
  z.object({ action: z.literal("save").optional(), requirementId: requirementIdSchema, answer: answerText, assumption: z.boolean().optional() })
]);

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

  return json(await loadChecklist(studyId));
}

/**
 * Write one answer, or accept suggestions. Every route here records who and when for a confirmation, and any change
 * ends a confirmed study specification (the response says so in `confirmationCleared`).
 *
 *   { requirementId, answer, assumption? }      save the person's own answer (ANSWERED, or ASSUMED when assumption is true)
 *   { action: "accept", requirementId }         SUGGESTED -> ANSWERED (a guess becomes ASSUMED instead)
 *   { action: "assume", requirementId, answer? } mark the answer as an assumption (ASSUMED)
 *   { action: "unknown", requirementId }        "Not decided yet" (UNKNOWN)
 *   { action: "acceptAll" }                     accept every suggestion in one call
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
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

  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid requirement answer.");
  const body = parsed.data;

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const now = new Date();
  const rows = await loadQuestionRows(studyId);
  const byId = new Map(rows.map((row) => [row.requirementId, row]));
  const key = (requirementId: string) => ({ studyId_requirementId: { studyId, requirementId } });

  type Write = { requirementId: RequirementId; answer: string; status: "ANSWERED" | "ASSUMED" | "UNKNOWN"; evidenceClass: "fact" | "assumption" | "unknown"; keepNote: boolean };
  const writes: Write[] = [];
  let action: "save" | "accept" | "accept_all" | "assume" | "unknown" = "save";

  const changedSince = () => problem(409, "The suggested answers changed while you were reading them. Nothing was accepted. Reload the list and check them again.", "suggestion_changed");

  /** A suggestion the person accepts: a guess stays marked as a guess. */
  const acceptance = (requirementId: RequirementId): Write | null => {
    const row = byId.get(requirementId);
    if (!row || row.status !== "SUGGESTED" || !row.answer.trim()) return null;
    const guess = row.evidenceClass === "assumption";
    return { requirementId, answer: row.answer, status: guess ? "ASSUMED" : "ANSWERED", evidenceClass: guess ? "assumption" : "fact", keepNote: true };
  };

  if ("action" in body && body.action === "acceptAll") {
    action = "accept_all";
    const seen = body.seen ? new Map(body.seen.map((entry) => [entry.requirementId, entry.answer.trim()])) : null;
    for (const id of REQUIREMENT_ORDER) {
      const write = acceptance(id);
      if (!write) {
        if (seen?.has(id)) return changedSince();
        continue;
      }
      if (seen && seen.get(id) !== write.answer.trim()) return changedSince();
      writes.push(write);
    }
    // A suggestion the person never saw is not accepted by this call.
    if (seen && writes.length !== seen.size) return changedSince();
  } else if ("action" in body && body.action === "accept") {
    action = "accept";
    const write = acceptance(body.requirementId);
    if (!write) return problem(409, "There is no suggested answer to accept for this question.", "no_suggestion");
    if (body.seenAnswer !== undefined && body.seenAnswer.trim() !== write.answer.trim()) return changedSince();
    writes.push(body.answer ? { ...write, answer: body.answer, keepNote: false } : write);
  } else if ("action" in body && body.action === "assume") {
    action = "assume";
    const answer = body.answer ?? byId.get(body.requirementId)?.answer.trim();
    if (!answer) return problem(409, "Write an answer first, then mark it as an assumption.", "no_answer");
    writes.push({ requirementId: body.requirementId, answer, status: "ASSUMED", evidenceClass: "assumption", keepNote: false });
  } else if ("action" in body && body.action === "unknown") {
    action = "unknown";
    writes.push({ requirementId: body.requirementId, answer: byId.get(body.requirementId)?.answer ?? "", status: "UNKNOWN", evidenceClass: "unknown", keepNote: false });
  } else if ("requirementId" in body && "answer" in body && body.answer) {
    const assumption = "assumption" in body && body.assumption === true;
    writes.push({ requirementId: body.requirementId, answer: body.answer, status: assumption ? "ASSUMED" : "ANSWERED", evidenceClass: assumption ? "assumption" : "fact", keepNote: false });
  }

  const saved = [] as Array<{ id: string; requirementId: string }>;
  for (const write of writes) {
    // "Not decided yet" is a person's mark too: it records who and when, so a later draft leaves it alone.
    const person = true;
    const data = {
      answer: write.answer,
      status: write.status,
      evidenceClass: write.evidenceClass,
      respondedById: userId,
      confirmedById: person ? userId : null,
      confirmedAt: person ? now : null,
      ...(write.keepNote ? {} : { sourceNote: null })
    };
    const row = await prisma.requirementResponse.upsert({
      where: key(write.requirementId),
      create: { studyId, requirementId: write.requirementId, ...data, sourceNote: null },
      update: data
    });
    saved.push({ id: row.id, requirementId: write.requirementId });
  }

  const confirmationCleared = writes.length > 0 ? await clearSpecificationConfirmation(studyId) : false;
  const checklist = await loadChecklist(studyId);

  await audit({
    actorUserId: userId,
    orgId: study.orgId,
    studyId,
    action: action === "save" ? "study.requirement.answer" : `study.requirement.${action}`,
    targetType: "RequirementResponse",
    targetId: saved.length === 1 ? saved[0]!.id : undefined,
    // Ids and counts only, never the answers.
    metadata: { requirementIds: saved.map((item) => item.requirementId).filter(isRequirementId), changed: saved.length, confirmationCleared },
    request
  });
  if (confirmationCleared) {
    await audit({ actorUserId: userId, orgId: study.orgId, studyId, action: "study.specification.cleared", targetType: "Study", targetId: studyId, metadata: { reason: action }, request });
  }

  const single = saved.length === 1 ? (checklist.requirements.find((item) => item.id === saved[0]!.requirementId)?.response ?? null) : null;
  return json({ ...checklist, response: single, ...(action === "accept_all" ? { accepted: saved.length } : {}), confirmationCleared });
}

/** The original write ({ requirementId, answer }) keeps working: it is the same as PATCH without an action. */
export const POST = PATCH;
