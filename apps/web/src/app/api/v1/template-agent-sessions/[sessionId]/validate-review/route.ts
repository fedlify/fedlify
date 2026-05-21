import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { normalizeReviewChangedFiles } from "@/lib/template-review-agent";
import { applyReviewChangesToFiles, LegacyTemplateSourceError, loadTemplateSourceForReview, TemplateSourceNotFoundError } from "@/lib/template-source";

const changedFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  originalContent: z.string().optional(),
  proposedContent: z.string().max(1_000_000),
  reason: z.string().trim().max(2000).optional()
});

const validateReviewSchema = z.object({
  changedFiles: z.array(changedFileSchema).max(20).optional()
});

type Params = { params: Promise<{ sessionId: string }> };

async function assertSessionAccess(input: { userId: string; requestedById: string; studyId: string | null }) {
  if (input.requestedById === input.userId) return;
  if (input.studyId) {
    await assertStudyAccess(input.userId, input.studyId, "runAgent");
    return;
  }
  const error = new Error("You do not have permission to validate this template review session.");
  error.name = "ForbiddenError";
  throw error;
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;
  const parsed = validateReviewSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid review validation request.");

  const session = await prisma.templateAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return problem(404, "Template review session was not found.", "not_found");
  if (session.mode !== "REVIEW_TEMPLATE_SOURCE" || !session.templateId) {
    return problem(409, "This session is not a template source review session.", "invalid_session_mode");
  }

  try {
    await assertSessionAccess({ userId: authResult.userId, requestedById: session.requestedById, studyId: session.studyId });
    const sourceRef = ((session.intake as Record<string, unknown> | null)?.sourceRef as string | undefined) ?? "current";
    const source = await loadTemplateSourceForReview({ templateId: session.templateId, sourceRef });
    const changedFiles = normalizeReviewChangedFiles({
      changedFiles: parsed.data.changedFiles ?? session.generatedFiles,
      sourceFiles: source.files
    });
    if (changedFiles.length === 0) return problem(409, "There are no proposed file changes to validate.", "no_review_changes");

    const proposedFiles = applyReviewChangesToFiles(source.files, changedFiles);
    const validation = validateTemplateRepositoryFiles(proposedFiles);
    const updated = await prisma.templateAgentSession.update({
      where: { id: session.id },
      data: {
        generatedFiles: changedFiles as unknown as Prisma.InputJsonValue,
        status: validation.status === "PASSED" ? "DRAFT_READY" : "CODING",
        resultSummary: validation.summary,
        intake: {
          ...((session.intake as Record<string, unknown> | null) ?? {}),
          sourceRef: source.ref,
          validationStatus: validation.status,
          validationSummary: validation.summary,
          validationErrors: validation.errors
        }
      }
    });

    return json({ session: updated, validation, changedFiles });
  } catch (error) {
    if (error instanceof LegacyTemplateSourceError) return problem(409, error.message, "legacy_template_source_missing");
    if (error instanceof TemplateSourceNotFoundError) return problem(404, error.message, "not_found");
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }
}
