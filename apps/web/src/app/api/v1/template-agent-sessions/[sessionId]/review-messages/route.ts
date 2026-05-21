import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { runTemplateReviewAgent } from "@/lib/template-review-agent";
import { LegacyTemplateSourceError, loadTemplateSourceForReview, TemplateSourceNotFoundError } from "@/lib/template-source";

const reviewMessageSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  selectedPath: z.string().trim().max(500).optional(),
  sourceRef: z.string().trim().max(200).optional()
});

type Params = { params: Promise<{ sessionId: string }> };

function asMessageList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item != null) : [];
}

function parseManifest(files: Array<{ path: string; content: string }>) {
  const manifest = files.find((file) => file.path === ".fedlify/template.json" || file.path === "fedlify-pipeline.json");
  if (!manifest) return null;
  try {
    return JSON.parse(manifest.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function assertSessionAccess(input: { userId: string; requestedById: string; studyId: string | null }) {
  if (input.requestedById === input.userId) return;
  if (input.studyId) {
    await assertStudyAccess(input.userId, input.studyId, "runAgent");
    return;
  }
  const error = new Error("You do not have permission to use this template review session.");
  error.name = "ForbiddenError";
  throw error;
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;
  const parsed = reviewMessageSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template review message.");

  const session = await prisma.templateAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return problem(404, "Template review session was not found.", "not_found");
  if (session.mode !== "REVIEW_TEMPLATE_SOURCE" || !session.templateId) {
    return problem(409, "This session is not a template source review session.", "invalid_session_mode");
  }

  try {
    await assertSessionAccess({ userId: authResult.userId, requestedById: session.requestedById, studyId: session.studyId });
    const sourceRef = parsed.data.sourceRef ?? ((session.intake as Record<string, unknown> | null)?.sourceRef as string | undefined) ?? "current";
    const source = await loadTemplateSourceForReview({ templateId: session.templateId, sourceRef });
    const now = new Date().toISOString();
    const priorMessages = asMessageList(session.messages);
    const result = await runTemplateReviewAgent({
      message: parsed.data.message,
      selectedPath: parsed.data.selectedPath,
      sourceRef: source.ref,
      repoUrl: source.repoUrl,
      commit: source.commit,
      files: source.files,
      manifest: parseManifest(source.files),
      priorMessages
    });

    const messages = [
      ...priorMessages,
      { role: "user", content: parsed.data.message, selectedPath: parsed.data.selectedPath ?? null, createdAt: now },
      {
        role: "assistant",
        content: result.assistantMessage,
        createdAt: now,
        questions: result.questions,
        safetyChecks: result.safetyChecks,
        changedFiles: result.changedFiles.map((file) => ({ path: file.path, reason: file.reason })),
        openAiUsed: result.openAiUsed,
        aiConfigured: result.aiConfigured
      }
    ] as Prisma.InputJsonValue;

    const updated = await prisma.templateAgentSession.update({
      where: { id: session.id },
      data: {
        messages,
        generatedFiles: result.changedFiles as unknown as Prisma.InputJsonValue,
        status: result.questions.length > 0 && result.changedFiles.length === 0 ? "INTAKE" : "DRAFT_READY",
        resultSummary: result.assistantMessage,
        intake: {
          ...((session.intake as Record<string, unknown> | null) ?? {}),
          sourceRef: source.ref,
          selectedPath: parsed.data.selectedPath ?? null,
          commit: source.commit,
          repoUrl: source.repoUrl,
          validationStatus: null,
          validationSummary: null
        }
      }
    });

    return json({
      session: updated,
      result,
      requiresClarification: result.questions.length > 0 && result.changedFiles.length === 0
    });
  } catch (error) {
    if (error instanceof LegacyTemplateSourceError) return problem(409, error.message, "legacy_template_source_missing");
    if (error instanceof TemplateSourceNotFoundError) return problem(404, error.message, "not_found");
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }
}
