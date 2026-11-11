import type { PipelineTemplate } from "@prisma/client";
import { GiteaApiError, giteaBranchTreeUrl, readGiteaRepositoryFiles } from "@/lib/gitea";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { isLegacyTemplateCommit, parseSourceRef, toReviewSourceFiles, type ReviewSourceFile } from "@/lib/source-review";

export type TemplateSourcePayload = {
  template: PipelineTemplate & { currentApprovedVersion?: { gitCommit: string; gitBranch: string | null } | null };
  ref: string;
  gitRef: string;
  commit: string | null;
  branchName: string | null;
  repoUrl: string;
  branchUrl: string | null;
  pullRequestUrl: string | null;
  files: ReviewSourceFile[];
};

export class LegacyTemplateSourceError extends Error {
  constructor() {
    super("This template is a legacy seed and has no reviewable source repository yet. Initialize a source repo with Codex to review code in Fedlify.");
    this.name = "LegacyTemplateSourceError";
  }
}

export class TemplateSourceNotFoundError extends Error {
  constructor(message = "Template source was not found.") {
    super(message);
    this.name = "TemplateSourceNotFoundError";
  }
}

export async function assertTemplateSourceAccess(userId: string, template: Pick<PipelineTemplate, "scope" | "studyId">): Promise<void> {
  if (template.scope !== "STUDY_TEMPLATE" || !template.studyId) return;
  await assertStudyAccess(userId, template.studyId, "read");
}

export function templateSourceProblemCode(error: unknown): string | null {
  if (error instanceof LegacyTemplateSourceError) return "legacy_template_source_missing";
  if (error instanceof TemplateSourceNotFoundError) return "not_found";
  if (isForbiddenError(error)) return "forbidden";
  if (error instanceof GiteaApiError) return "gitea_api_error";
  return null;
}

export async function loadTemplateSourceForReview(input: {
  templateId: string;
  sourceRef?: string | null;
}): Promise<TemplateSourcePayload> {
  const sourceRef = parseSourceRef(input.sourceRef);
  const template = await prisma.pipelineTemplate.findUnique({
    where: { id: input.templateId },
    include: { currentApprovedVersion: true }
  });
  if (!template) throw new TemplateSourceNotFoundError("Pipeline template not found.");

  let ref = "current";
  let gitRef: string | null | undefined;
  let commit: string | null | undefined;
  let branchName: string | null | undefined;

  if (sourceRef.kind === "current") {
    const version = template.currentApprovedVersion;
    if (!version) throw new TemplateSourceNotFoundError("Template has no approved version to review.");
    ref = "current";
    gitRef = version.gitCommit;
    commit = version.gitCommit;
    branchName = version.gitBranch;
  }

  if (sourceRef.kind === "version") {
    const version = await prisma.pipelineTemplateVersion.findFirst({
      where: { id: sourceRef.id, templateId: input.templateId }
    });
    if (!version) throw new TemplateSourceNotFoundError("Template version not found.");
    ref = `version:${version.id}`;
    gitRef = version.gitCommit;
    commit = version.gitCommit;
    branchName = version.gitBranch;
  }

  // A template without its own source repository (an old seed) has nothing to read.
  if (!template.giteaOwner || !template.giteaRepo || !template.giteaRepoUrl || !gitRef || isLegacyTemplateCommit(gitRef)) {
    throw new LegacyTemplateSourceError();
  }

  const files = await readGiteaRepositoryFiles({ owner: template.giteaOwner, repo: template.giteaRepo, ref: gitRef });
  return {
    template,
    ref,
    gitRef,
    commit: commit ?? null,
    branchName: branchName ?? null,
    repoUrl: template.giteaRepoUrl,
    branchUrl: branchName ? giteaBranchTreeUrl(template.giteaRepoUrl, branchName) : null,
    pullRequestUrl: null,
    files: toReviewSourceFiles(files)
  };
}
