import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createGiteaTemplateProposal, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { templateKeyForName, templateRepoName, validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";

const forkSchema = z.object({
  templateId: z.string().min(1),
  templateVersionId: z.string().min(1).optional(),
  name: z.string().trim().min(3).max(200).optional(),
  prompt: z.string().trim().max(12000).optional()
});

type Params = { params: Promise<{ studyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = forkSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template fork request.");

  const sourceTemplate = await prisma.pipelineTemplate.findUnique({
    where: { id: parsed.data.templateId },
    include: { currentApprovedVersion: true, templateVersions: true }
  });
  if (!sourceTemplate || sourceTemplate.scope !== "PUBLIC_TEMPLATE") {
    return problem(404, "Public template was not found.", "template_not_found");
  }
  const sourceVersion =
    (parsed.data.templateVersionId
      ? sourceTemplate.templateVersions.find((version) => version.id === parsed.data.templateVersionId)
      : sourceTemplate.currentApprovedVersion) ?? null;
  if (!sourceVersion || sourceVersion.approvalStatus !== "APPROVED" || sourceVersion.validationStatus !== "PASSED") {
    return problem(409, "Only approved public template versions can be forked into a study.", "template_version_not_approved");
  }
  if (!sourceTemplate.giteaOwner || !sourceTemplate.giteaRepo || sourceVersion.gitCommit.startsWith("legacy-seed-")) {
    return problem(409, "This template has no reviewable source repository to fork.", "legacy_template_source_missing");
  }

  let files;
  let workspace;
  try {
    files = await readGiteaRepositoryFiles({
      owner: sourceTemplate.giteaOwner,
      repo: sourceTemplate.giteaRepo,
      ref: sourceVersion.gitCommit
    });
    workspace = await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const validation = validateTemplateRepositoryFiles(files);
  if (validation.status !== "PASSED") return problem(422, validation.summary, "template_validation_failed");

  const name = parsed.data.name ?? `${sourceTemplate.name} study template`;
  const repoName = templateRepoName(name);
  const branchName = `fedlify/fork-${slugify(name).slice(0, 42)}-${Date.now().toString(36)}`;
  const sourceSpec = JSON.parse(JSON.stringify(sourceTemplate.spec ?? {})) as Prisma.InputJsonValue;

  let gitea;
  try {
    gitea = await createGiteaTemplateProposal({
      owner: workspace.owner,
      repoName,
      templateName: name,
      description: `Study-private fork of ${sourceTemplate.name}.`,
      branchName,
      files,
      pullRequestBody: [
        `Forked from public template: ${sourceTemplate.name}`,
        `Source commit: ${sourceVersion.gitCommit}`,
        "",
        parsed.data.prompt ?? "Study team can edit this fork before approving it for study pipeline generation.",
        "",
        validation.summary
      ].join("\n")
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const result = await prisma.$transaction(async (tx) => {
    const template = await tx.pipelineTemplate.create({
      data: {
        name,
        templateKey: templateKeyForName(name),
        scope: "STUDY_TEMPLATE",
        studyId,
        sourceTemplateId: sourceTemplate.id,
        sourceTemplateVersionId: sourceVersion.id,
        forkedFromCommit: sourceVersion.gitCommit,
        framework: sourceTemplate.framework,
        description: sourceTemplate.description,
        version: "1.0.0",
        spec: sourceSpec,
        active: true,
        status: "VALIDATED",
        giteaOwner: gitea.owner,
        giteaRepo: gitea.repo,
        giteaRepoUrl: gitea.repoUrl,
        giteaDefaultBranch: gitea.baseBranch,
        createdById: authResult.userId
      }
    });

    const proposal = await tx.templateProposal.create({
      data: {
        templateId: template.id,
        requestedById: authResult.userId,
        kind: "NEW_TEMPLATE",
        intakeAnswers: sourceSpec,
        prompt: parsed.data.prompt ?? `Fork ${sourceTemplate.name} into this study workspace.`,
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

    return { template, proposal };
  });

  await audit({
    actorUserId: authResult.userId,
    studyId,
    action: "study_template.fork",
    targetType: "PipelineTemplate",
    targetId: result.template.id,
    metadata: {
      sourceTemplateId: sourceTemplate.id,
      sourceTemplateVersionId: sourceVersion.id,
      forkedFromCommit: sourceVersion.gitCommit,
      giteaRepo: `${gitea.owner}/${gitea.repo}`,
      giteaPullRequestNumber: gitea.pullRequestNumber
    },
    request
  });

  return json(result, { status: 201 });
}
