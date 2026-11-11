/**
 * POST { text }: the assistant drafts answers to the 29 study questions from a description the person pastes or types.
 *
 * The assistant proposes, a person decides: every drafted answer is stored as SUGGESTED, UNKNOWN or CONFLICT and none of
 * them counts as answered. An answer a person already gave (ANSWERED or ASSUMED, including older rows) is never
 * overwritten; a disagreement with it is only reported in `conflictNotes`.
 *
 * The pasted text goes through the control plane like an assistant turn (contract assistant.requirements.v1): shadow
 * records it, enforce stops it before any model call when it holds secrets or patient-level rows. The text itself is
 * never stored; the audit entry and the work item hold hashes and counts only.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { guardAssistantTurn, openAssistantTurn, type AssistantTurnHandle } from "@/lib/assistant-control";
import { sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { acquireSlot, rateLimit } from "@/lib/rate-limit";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { REQUIREMENT_ORDER } from "@/lib/requirements-catalog";
import { openAiCodeAgentConfig } from "@/lib/runtime-config";
import { DRAFT_MAX_CHARS, isPersonAnswer, isPersonMark, type StoredQuestionRow } from "@/lib/study-questions";
import {
  buildDraftInput,
  callStructuredModel,
  DRAFT_JSON_SCHEMA,
  DRAFT_MAX_OUTPUT_TOKENS,
  DRAFT_PROMPT_VERSION,
  DRAFT_TIMEOUT_MS,
  normalizeDraft
} from "@/lib/study-questions-model";
import { loadChecklist, loadQuestionRows } from "@/lib/study-questions-store";

const bodySchema = z.object({ text: z.string() });
const DRAFT_MAX_BODY_BYTES = 200_000;
const REPLACEABLE = ["SUGGESTED", "UNKNOWN", "CONFLICT"];

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

  // Refuse an oversized body before it is parsed (40,000 characters is at most about 160,000 bytes).
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > DRAFT_MAX_BODY_BYTES) {
    return problem(413, `That description is too long (the limit is ${DRAFT_MAX_CHARS.toLocaleString("en-GB")} characters). Paste a shorter summary.`, "text_too_long");
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, "Describe your study in the box first.", "text_required");
  const text = parsed.data.text.trim();
  if (!text) return problem(400, "Describe your study in the box first.", "text_required");
  if (text.length > DRAFT_MAX_CHARS) {
    return problem(413, `That description is too long (${text.length.toLocaleString("en-GB")} characters; the limit is ${DRAFT_MAX_CHARS.toLocaleString("en-GB")}). Paste a shorter summary.`, "text_too_long");
  }

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const config = openAiCodeAgentConfig();
  if (!config) return problem(503, "The assistant is not set up on this server. You can still answer the questions yourself.", "assistant_unavailable");

  if (!rateLimit(`study-questions-draft:${userId}`, 6, 60_000)) return problem(429, "You have asked for several drafts in a short time. Wait a minute and try again.", "rate_limited");
  const release = acquireSlot(`study-questions-draft:${userId}`, 1);
  if (!release) return problem(429, "A draft is already being written. Wait for it to finish.", "busy");

  let control: AssistantTurnHandle | null = null;
  try {
    const turn = {
      studyId,
      projectId: `study-questions:${studyId}`,
      userId,
      mode: "requirements" as const,
      clientTurnId: randomUUID(),
      userText: text
    };
    // Enforced studies only: the check finishes BEFORE any model call. A no-op otherwise.
    const gate = await guardAssistantTurn(turn);
    if (gate.enforced && gate.blocked) {
      await audit({
        actorUserId: userId,
        orgId: study.orgId,
        studyId,
        action: "study.requirements.draft_stopped",
        targetType: "Study",
        targetId: studyId,
        metadata: { code: gate.stop.code, codes: gate.stop.codes ?? [], workItemId: gate.workItemId, chars: text.length },
        request
      }).catch(() => undefined);
      return json({ stopped: true, stop: gate.stop });
    }
    control = gate.enforced ? gate.handle : openAssistantTurn(turn);

    const rows = await loadQuestionRows(studyId);
    const byId = new Map(rows.map((row) => [row.requirementId, row]));
    const confirmed = REQUIREMENT_ORDER.filter((id) => isPersonAnswer(byId.get(id)) && byId.get(id)!.answer.trim()).map((id) => ({ id, answer: byId.get(id)!.answer.slice(0, 600) }));

    const result = await callStructuredModel(config, {
      input: buildDraftInput({ text, confirmed }),
      schemaName: "fedlify_study_draft",
      schema: DRAFT_JSON_SCHEMA,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      timeoutMs: DRAFT_TIMEOUT_MS,
      signal: request.signal,
      label: "study-questions-draft"
    });
    if (!result.ok) {
      void control.done("error", { model: config.model });
      return problem(result.code === "unreadable" ? 502 : result.code === "timeout" ? 504 : 502, result.message, result.code === "unreadable" ? "draft_unreadable" : "upstream_error");
    }

    const draft = normalizeDraft(result.value, text);
    // The model can take a while and people keep working: read the rows again and write only over rows the assistant
    // wrote and no person has touched since. The write itself is conditional, so a late answer is never lost.
    const fresh = await loadQuestionRows(studyId);
    const freshById = new Map(fresh.map((row) => [row.requirementId, row]));
    const counts = { suggested: 0, unknown: 0, conflicts: 0, unchanged: 0, replaced: 0 };
    const conflictNotes: Array<{ requirementId: string; note: string }> = [];
    const toCreate: Array<Record<string, unknown>> = [];
    const toUpdate: Array<{ id: string; status: string; data: Record<string, unknown> }> = [];
    for (const id of REQUIREMENT_ORDER) {
      const item = draft.get(id)!;
      const existing: StoredQuestionRow | undefined = freshById.get(id);
      // A person's answer, and a "Not decided yet" a person chose on purpose, are never overwritten.
      if (isPersonAnswer(existing) || isPersonMark(existing)) {
        if (item.evidenceClass === "conflict" && isPersonAnswer(existing)) {
          counts.conflicts += 1;
          conflictNotes.push({ requirementId: id, note: item.sourceNote });
        } else counts.unchanged += 1;
        continue;
      }
      const status = item.evidenceClass === "conflict" ? "CONFLICT" : item.evidenceClass === "unknown" ? "UNKNOWN" : "SUGGESTED";
      const data = { answer: item.answer ?? "", status, evidenceClass: item.evidenceClass, sourceNote: item.sourceNote, respondedById: userId, confirmedById: null, confirmedAt: null };
      if (existing) toUpdate.push({ id, status, data });
      else toCreate.push({ studyId, requirementId: id, ...data });
    }
    const operations = [
      ...(toCreate.length ? [prisma.requirementResponse.createMany({ data: toCreate as never, skipDuplicates: true })] : []),
      ...toUpdate.map((entry) =>
        prisma.requirementResponse.updateMany({
          where: { studyId, requirementId: entry.id, status: { in: REPLACEABLE }, confirmedById: null },
          data: entry.data as never
        })
      )
    ];
    const results = (await prisma.$transaction(operations)) as Array<{ count: number }>;
    const createdCount = toCreate.length ? (results[0]?.count ?? 0) : 0;
    const updateResults = toCreate.length ? results.slice(1) : results;
    const tally = (status: string) => {
      if (status === "SUGGESTED") counts.suggested += 1;
      else if (status === "UNKNOWN") counts.unknown += 1;
      else counts.conflicts += 1;
    };
    // Rows that were created: count them by status (a create that lost a race is counted as unchanged below).
    let createdLeft = createdCount;
    for (const row of toCreate) {
      if (createdLeft > 0) {
        tally(String(row.status));
        createdLeft -= 1;
      } else counts.unchanged += 1;
    }
    toUpdate.forEach((entry, index) => {
      if ((updateResults[index]?.count ?? 0) > 0) {
        tally(entry.status);
        const previous = freshById.get(entry.id);
        if (previous?.status === "SUGGESTED" && previous.answer.trim()) counts.replaced += 1;
      } else counts.unchanged += 1;
    });

    // The assistant only writes rows no person has confirmed, so nothing here ends a confirmed specification.
    // The audit entry must not turn a stored draft into an error.
    await audit({
      actorUserId: userId,
      orgId: study.orgId,
      studyId,
      action: "study.requirements.draft",
      targetType: "Study",
      targetId: studyId,
      // Hash and counts only: the pasted text is not kept.
      metadata: { textHash: sha256(text), chars: text.length, ...counts, model: config.model, promptVersion: DRAFT_PROMPT_VERSION },
      request
    }).catch((error) => console.error("study-questions-draft audit failed", error instanceof Error ? error.message : error));
    void control.done("done", { model: config.model });

    const checklist = await loadChecklist(studyId);
    return json({ ...checklist, summary: counts, conflictNotes });
  } finally {
    void control?.done("error", { model: config.model });
    release();
  }
}
