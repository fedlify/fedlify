import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { isForbiddenError } from "@/lib/rbac";
import { assertTemplateSourceAccess, LegacyTemplateSourceError, loadTemplateSourceForReview, TemplateSourceNotFoundError } from "@/lib/template-source";

export async function GET(request: NextRequest, context: { params: Promise<{ templateId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { templateId } = await context.params;
  const sourceRef = new URL(request.url).searchParams.get("ref");

  try {
    const source = await loadTemplateSourceForReview({ templateId, sourceRef });
    await assertTemplateSourceAccess(authResult.userId, source.template);
    return json({
      ref: source.ref,
      gitRef: source.gitRef,
      commit: source.commit,
      branchName: source.branchName,
      repoUrl: source.repoUrl,
      branchUrl: source.branchUrl,
      pullRequestUrl: source.pullRequestUrl,
      files: source.files
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
