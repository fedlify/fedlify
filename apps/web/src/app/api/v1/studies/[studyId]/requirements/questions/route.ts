/**
 * POST {}: the next open study questions (up to 4), as plain questions with 2 to 4 options where sensible.
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
import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import { isPersonAnswer, nextOpenItems } from "@/lib/study-questions";
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
  const openIds = nextOpenItems(rows);
  if (openIds.length === 0) return json({ questions: [], source: "none", openCount: 0 });

  const openCount = nextOpenItems(rows, 29).length;
  const fallback = (reason?: string) => json({ questions: openIds.map(fallbackQuestion), source: "catalog", openCount, ...(reason ? { notice: reason } : {}) });

  const config = openAiCodeAgentConfig();
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
    label: "study-questions-ask"
  });
  if (!result.ok) return fallback("The assistant could not word these questions just now, so the standard questions are shown.");
  return json({ questions: normalizeQuestions(result.value, openIds), source: "assistant", openCount });
}
