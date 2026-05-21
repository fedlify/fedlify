import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createGiteaTemplateProposal, GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { normalizeReviewChangedFiles } from "@/lib/template-review-agent";
import { applyReviewChangesToFiles, LegacyTemplateSourceError, loadTemplateSourceForReview, TemplateSourceNotFoundError } from "@/lib/template-source";

const changedFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  originalContent: z.string().optional(),
  proposedContent: z.string().max(1_000_000),
  reason: z.string().trim().max(2000).optional()
});

const applyReviewSchema = z.object({
  changedFiles: z.array(changedFileSchema).max(20).optional()
});

type Params = { params: Promise<{ sessionId: string }> };

function asMessageList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item != null) : [];
}

async function assertSessionAccess(input: { userId: string; requestedById: string; studyId: string | null }) {
  if (input.requestedById === input.userId) return;
  if (input.studyId) {
    await assertStudyAccess(input.userId, input.studyId, "runAgent");
    return;
  }
  const error = new Error("You do not have permission to apply this template review session.");
  error.name = "ForbiddenError";
  throw error;
}

function promptFromMessages(messages: Array<Record<string, unknown>>, changedFiles: Array<{ path: string; reason: string }>) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user" && typeof message.content === "string");
  return [
    typeof lastUser?.content === "string" ? lastUser.content : "Inline Codex code review change.",
    "",
    "Changed files:",
    ...changedFiles.map((file) => `- ${file.path}: ${file.reason}`)
  ].join("\n");
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;
  const parsed = applyReviewSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid review apply request.");

  const session = await prisma.templateAgentSession.findUnique({
    where: { id: sessionId },
    include: { template: true }
  });
  if (!session) return problem(404, "Template review session was not found.", "not_found");
  if (session.mode !== "REVIEW_TEMPLATE_SOURCE" || !session.templateId || !session.template) {
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
    if (changedFiles.length === 0) return problem(409, "There are no proposed file changes to apply.", "no_review_changes");

    const files = applyReviewChangesToFiles(source.files, changedFiles);
    const validation = validateTemplateRepositoryFiles(files);
    if (validation.status !== "PASSED") return problem(422, validation.summary, "template_validation_failed");
    if (!session.template.giteaOwner || !session.template.giteaRepo) {
      return problem(409, "Template source repository is not linked.", "template_source_not_linked");
    }

    const branchName = `fedlify/review-${slugify(session.template.name).slice(0, 42)}-${Date.now().toString(36)}`;
    const messages = asMessageList(session.messages);
    const prompt = promptFromMessages(messages, changedFiles);
    const gitea = await createGiteaTemplateProposal({
      owner: session.template.giteaOwner,
      repoName: session.template.giteaRepo,
      templateName: session.template.name,
      description: session.template.description ?? `Fedlify NVFLARE template: ${session.template.name}`,
      branchName,
      files,
      pullRequestBody: [
        `Inline Codex review proposal for ${session.template.name}`,
        `Session: ${session.id}`,
        "",
        "This draft pull request was created from Fedlify's inline code review workflow.",
        "Publishing still requires validation and human approval.",
        "",
        "Validation summary:",
        validation.summary,
        "",
        "Requested change:",
        prompt
      ].join("\n")
    });

    const result = await prisma.$transaction(async (tx) => {
      const proposal = await tx.templateProposal.create({
        data: {
          templateId: session.templateId!,
          requestedById: authResult.userId,
          kind: "CHANGE_TEMPLATE",
          intakeAnswers: (session.template?.spec ?? {}) as Prisma.InputJsonValue,
          prompt,
          branchName: gitea.branchName,
          giteaPullRequestUrl: gitea.pullRequestUrl,
          giteaPullRequestNumber: gitea.pullRequestNumber,
          giteaHeadCommit: gitea.commitSha,
          giteaBaseBranch: gitea.baseBranch,
          status: "OPEN",
          validationStatus: "PASSED",
          resultSummary: validation.summary
        }
      });

      const updatedSession = await tx.templateAgentSession.update({
        where: { id: session.id },
        data: {
          status: "APPLIED",
          generatedFiles: changedFiles as unknown as Prisma.InputJsonValue,
          resultSummary: validation.summary,
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          branchName: gitea.branchName,
          giteaPullRequestUrl: gitea.pullRequestUrl,
          giteaHeadCommit: gitea.commitSha,
          intake: {
            ...((session.intake as Record<string, unknown> | null) ?? {}),
            sourceRef: source.ref,
            validationStatus: validation.status,
            validationSummary: validation.summary,
            proposalId: proposal.id
          }
        }
      });

      return { proposal, session: updatedSession };
    });

    await audit({
      actorUserId: authResult.userId,
      studyId: session.studyId,
      action: "template_review.apply",
      targetType: "TemplateProposal",
      targetId: result.proposal.id,
      metadata: {
        sessionId: session.id,
        templateId: session.templateId,
        changedFiles: changedFiles.map((file) => file.path),
        giteaRepo: `${gitea.owner}/${gitea.repo}`,
        giteaPullRequestNumber: gitea.pullRequestNumber,
        gitCommit: gitea.commitSha
      },
      request
    });

    return json({
      session: result.session,
      proposal: result.proposal,
      validation,
      draftPrUrl: gitea.pullRequestUrl,
      branchName: gitea.branchName,
      commit: gitea.commitSha
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
