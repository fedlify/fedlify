/**
 * POST {}: the next open study questions (up to 4), as plain questions with 2 to 4 options where sensible.
 * POST { requirementId: "R05" }: the same for that one open question (409 when it already has an answer).
 * Open means UNKNOWN, CONFLICT or no answer yet; disagreements come first. The shape is the one PlanQuestionsCard
 * already shows. Each question id is the requirement id (R05), so the screen saves the chosen option or the typed text
 * as the person's own answer with PATCH .../requirements.
 *
 * One structured model call writes the wording and the options from the catalog and the existing answers. When the model
 * is not set up or fails, the catalog's own question with a free-text answer is returned instead (source "catalog").
 * The model never saves anything.
 */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { assistantModelConfig } from "@/lib/runtime-config";
import { REQUIREMENT_ORDER, type RequirementId } from "@/lib/requirements-catalog";
import { isPersonAnswer, isRequirementId, nextOpenItems } from "@/lib/study-questions";
import {
  buildQuestionsInput,
  callStructuredModel,
  fallbackQuestion,
  normalizeQuestions,
  openItemsForPrompt,
  QUESTIONS_JSON_SCHEMA,
  QUESTIONS_MAX_OUTPUT_TOKENS,
  QUESTIONS_TIMEOUT_MS
} from "@/lib/study-questions-model";
import { loadQuestionRows } from "@/lib/study-questions-store";

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { id: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const rows = await loadQuestionRows(studyId);
  const allOpen = nextOpenItems(rows, REQUIREMENT_ORDER.length);
  // { requirementId: "R05" } asks about that one question only (the question view's "Suggest answers to pick from").
  const body = (await request.json().catch(() => null)) as { requirementId?: unknown } | null;
  const wanted = typeof body?.requirementId === "string" ? body.requirementId : null;
  if (wanted !== null && !isRequirementId(wanted)) return problem(400, "Unknown study question.", "invalid_requirement");
  if (wanted !== null && !allOpen.includes(wanted as RequirementId)) {
    return problem(409, "This question already has an answer. Edit the answer instead.", "not_open");
  }
  const openIds = wanted ? [wanted as RequirementId] : nextOpenItems(rows);
  if (openIds.length === 0) return json({ questions: [], source: "none", openCount: 0 });

  const openCount = allOpen.length;
  const fallback = (reason?: string) => json({ questions: openIds.map(fallbackQuestion), source: "catalog", openCount, ...(reason ? { notice: reason } : {}) });

  const config = assistantModelConfig();
  if (!config) return fallback();
  if (!rateLimit(`study-questions-ask:${authResult.userId}`, 20, 60_000)) return fallback();

  const context_ = rows.filter((row) => isPersonAnswer(row) && row.answer.trim()).map((row) => ({ id: row.requirementId, answer: row.answer }));
  const result = await callStructuredModel(config, {
    input: buildQuestionsInput({ open: openItemsForPrompt(rows, openIds), context: context_ }),
    schemaName: "fedlify_study_questions",
    schema: QUESTIONS_JSON_SCHEMA,
    maxOutputTokens: QUESTIONS_MAX_OUTPUT_TOKENS,
    timeoutMs: QUESTIONS_TIMEOUT_MS,
    signal: request.signal,
    label: "study-questions-ask",
    studyId
    // No assistant-control work item exists for this call, so with ASSISTANT_MODEL_ROUTE=orchestrator it cannot be signed
    // and falls back to the standard questions below.
  });
  if (!result.ok) return fallback("The assistant could not word these questions just now, so the standard questions are shown.");
  return json({ questions: normalizeQuestions(result.value, openIds), source: "assistant", openCount });
}
