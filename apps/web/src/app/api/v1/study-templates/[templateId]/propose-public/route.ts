import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createGiteaTemplateProposal, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { ensurePublicTemplateWorkspace } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { templateRepoName, validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";

const proposePublicSchema = z.object({
  templateVersionId: z.string().min(1).optional(),
  name: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  prompt: z.string().trim().max(12000).optional()
});

type Params = { params: Promise<{ templateId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { templateId } = await params;
  const parsed = proposePublicSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid public template proposal.");

  const studyTemplate = await prisma.pipelineTemplate.findUnique({
    where: { id: templateId },
    include: { currentApprovedVersion: true, templateVersions: true }
  });
  if (!studyTemplate || studyTemplate.scope !== "STUDY_TEMPLATE" || !studyTemplate.studyId) {
    return problem(404, "Study template was not found.", "template_not_found");
  }

  try {
    await assertStudyAccess(authResult.userId, studyTemplate.studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const sourceVersion =
    (parsed.data.templateVersionId
      ? studyTemplate.templateVersions.find((version) => version.id === parsed.data.templateVersionId)
      : studyTemplate.currentApprovedVersion) ?? null;
  if (!sourceVersion || sourceVersion.approvalStatus !== "APPROVED" || sourceVersion.validationStatus !== "PASSED") {
    return problem(409, "Approve a study template version before proposing it for the public catalog.", "study_template_not_approved");
  }
  if (!studyTemplate.giteaOwner || !studyTemplate.giteaRepo) {
    return problem(409, "Study template has no source repository.", "template_source_missing");
  }

  let files;
  let publicWorkspace;
  try {
    files = await readGiteaRepositoryFiles({
      owner: studyTemplate.giteaOwner,
      repo: studyTemplate.giteaRepo,
      ref: sourceVersion.gitCommit
    });
    publicWorkspace = await ensurePublicTemplateWorkspace();
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const validation = validateTemplateRepositoryFiles(files);
  if (validation.status !== "PASSED") return problem(422, validation.summary, "template_validation_failed");

  const name = parsed.data.name ?? studyTemplate.name.replace(/\s+study template$/i, "");
  const studySpec = JSON.parse(JSON.stringify(studyTemplate.spec ?? {})) as Prisma.InputJsonValue;
  const publicTemplate =
    (studyTemplate.sourceTemplateId
      ? await prisma.pipelineTemplate.findFirst({ where: { id: studyTemplate.sourceTemplateId, scope: "PUBLIC_TEMPLATE" } })
      : null) ??
    (await prisma.pipelineTemplate.findFirst({
      where: { scope: "PUBLIC_TEMPLATE", templateKey: studyTemplate.templateKey },
      orderBy: { createdAt: "asc" }
    }));
  const repoName = publicTemplate?.giteaRepo ?? templateRepoName(name);
  const branchName = `fedlify/public-${slugify(name).slice(0, 42)}-${Date.now().toString(36)}`;

  let gitea;
  try {
    gitea = await createGiteaTemplateProposal({
      owner: publicWorkspace.owner,
      repoName,
      templateName: name,
      description: parsed.data.description ?? studyTemplate.description ?? `Reusable Fedlify NVFLARE template: ${name}`,
      branchName,
      files,
      pullRequestBody: [
        `Public template proposal: ${name}`,
        `Source study template: ${studyTemplate.id}`,
        `Source commit: ${sourceVersion.gitCommit}`,
        "",
        parsed.data.prompt ?? "Promote this study-private template as a reusable public Fedlify template.",
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
    const template =
      publicTemplate ??
      (await tx.pipelineTemplate.create({
        data: {
          name,
          templateKey: studyTemplate.templateKey,
          scope: "PUBLIC_TEMPLATE",
          framework: studyTemplate.framework,
          description: parsed.data.description ?? studyTemplate.description,
          version: "1.0.0",
          spec: studySpec,
          active: true,
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch,
          createdById: authResult.userId
        }
      }));

    if (publicTemplate) {
      await tx.pipelineTemplate.update({
        where: { id: publicTemplate.id },
        data: {
          name,
          description: parsed.data.description ?? studyTemplate.description,
          spec: studySpec,
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch
        }
      });
    }

    const proposal = await tx.templateProposal.create({
      data: {
        templateId: template.id,
        requestedById: authResult.userId,
        kind: publicTemplate ? "CHANGE_TEMPLATE" : "NEW_TEMPLATE",
        intakeAnswers: studySpec,
        prompt: parsed.data.prompt ?? "Promote a study-private template to the public catalog.",
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
    studyId: studyTemplate.studyId,
    action: "study_template.propose_public",
    targetType: "TemplateProposal",
    targetId: result.proposal.id,
    metadata: {
      studyTemplateId: studyTemplate.id,
      sourceVersionId: sourceVersion.id,
      publicTemplateId: result.template.id,
      giteaRepo: `${gitea.owner}/${gitea.repo}`,
      giteaPullRequestNumber: gitea.pullRequestNumber,
      gitCommit: gitea.commitSha
    },
    request
  });

  return json(result, { status: 201 });
}
