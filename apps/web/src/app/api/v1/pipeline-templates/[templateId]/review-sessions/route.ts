import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { isForbiddenError } from "@/lib/rbac";
import { assertTemplateSourceAccess, LegacyTemplateSourceError, loadTemplateSourceForReview, TemplateSourceNotFoundError } from "@/lib/template-source";

const reviewSessionSchema = z.object({
  sourceRef: z.string().trim().max(200).optional(),
  selectedPath: z.string().trim().max(500).optional()
});

type Params = { params: Promise<{ templateId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { templateId } = await params;
  const parsed = reviewSessionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid review session request.");

  try {
    const source = await loadTemplateSourceForReview({ templateId, sourceRef: parsed.data.sourceRef });
    await assertTemplateSourceAccess(authResult.userId, source.template);
    const selectedPath = parsed.data.selectedPath ?? source.files[0]?.path ?? null;
    const session = await prisma.templateAgentSession.create({
      data: {
        templateId: source.template.id,
        studyId: source.template.studyId,
        requestedById: authResult.userId,
        mode: "REVIEW_TEMPLATE_SOURCE",
        status: "CODING",
        intake: {
          sourceRef: source.ref,
          selectedPath,
          commit: source.commit,
          repoUrl: source.repoUrl
        },
        messages: [
          {
            role: "assistant",
            content: "Code review session ready. Ask for an explanation, safety review, or a draft change for the selected file.",
            createdAt: new Date().toISOString(),
            missing: []
          }
        ],
        resultSummary: "Template source review session started."
      }
    });

    return json({
      session,
      source: {
        ref: source.ref,
        commit: source.commit,
        branchName: source.branchName,
        repoUrl: source.repoUrl,
        pullRequestUrl: source.pullRequestUrl
      },
      aiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim())
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
