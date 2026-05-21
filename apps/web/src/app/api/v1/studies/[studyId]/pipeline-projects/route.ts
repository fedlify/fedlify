import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { zipFiles } from "@/lib/archive";
import { audit } from "@/lib/audit";
import { ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { GiteaApiError, createGiteaPipelineProposal, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import {
  buildNvflareJobPipelineFiles,
  filesToArchiveMap,
  pipelineJobWorkspacePath,
  pipelineProjectSlug,
  validatePipelineFiles,
  writeNvflareJobWorkspace
} from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";

const optionalNonEmptyString = (schema: z.ZodString) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

const createPipelineProjectSchema = z.object({
  templateId: z.string().min(1).optional(),
  templateVersionId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  name: optionalNonEmptyString(
    z.string().trim().min(3, "Pipeline workspace name must be at least 3 characters.").max(200)
  ),
  prompt: z.string().trim().min(20, "Agent request must be at least 20 characters.").max(12000),
  branchName: optionalNonEmptyString(
    z.string().trim().min(3, "Gitea branch must be at least 3 characters, or left blank for auto-generation.").max(160)
  ),
  giteaRepoUrl: optionalNonEmptyString(z.string().trim().url("Gitea repository URL must be a valid URL."))
});

function nextVersion(count: number) {
  return `v${count + 1}.0.0`;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const pipelineProjects = await prisma.pipelineProject.findMany({
    where: { studyId },
    include: {
      template: true,
      templateVersion: true,
      versions: { include: { ciRuns: true, templateVersion: true }, orderBy: { createdAt: "desc" } },
      proposals: { include: { ciRuns: true }, orderBy: { createdAt: "desc" } }
    },
    orderBy: { updatedAt: "desc" }
  });

  return json({ pipelineProjects });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = createPipelineProjectSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid pipeline request.");

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    include: {
      pipelineProjects: true,
      studySites: { include: { site: true } }
    }
  });
  if (!study) return problem(404, "Study not found.", "not_found");

  const selectedTemplateVersion = parsed.data.templateVersionId
    ? await prisma.pipelineTemplateVersion.findUnique({
        where: { id: parsed.data.templateVersionId },
        include: { template: { include: { currentApprovedVersion: true } } }
      })
    : null;
  if (parsed.data.templateVersionId && !selectedTemplateVersion) {
    return problem(404, "Template version was not found.", "template_version_not_found");
  }
  if (parsed.data.templateId && selectedTemplateVersion && selectedTemplateVersion.templateId !== parsed.data.templateId) {
    return problem(409, "Template version does not belong to the selected template.", "template_version_mismatch");
  }
  const template = selectedTemplateVersion?.template
    ?? (parsed.data.templateId
      ? await prisma.pipelineTemplate.findUnique({ where: { id: parsed.data.templateId }, include: { currentApprovedVersion: true } })
      : await prisma.pipelineTemplate.findFirst({
          where: { active: true, framework: "nvflare", scope: "PUBLIC_TEMPLATE" },
          include: { currentApprovedVersion: true },
          orderBy: { name: "asc" }
        }));
  if (!template) return problem(404, "No active NVFLARE pipeline template is available.", "template_not_found");
  if (!["PUBLIC_TEMPLATE", "STUDY_TEMPLATE"].includes(template.scope)) {
    return problem(409, "Only approved public or study templates can create study pipeline versions.", "template_scope_not_runnable");
  }
  if (template.scope === "STUDY_TEMPLATE" && template.studyId !== studyId) {
    return problem(404, "Study template was not found in this study workspace.", "template_not_found");
  }
  const approvedTemplateVersion = selectedTemplateVersion ?? template.currentApprovedVersion;
  if (!approvedTemplateVersion) {
    return problem(409, "Select an approved template version before creating a study pipeline.", "template_version_required");
  }
  if (approvedTemplateVersion.approvalStatus !== "APPROVED" || approvedTemplateVersion.validationStatus !== "PASSED") {
    return problem(
      409,
      "Selected template version is not published for study use. Publish a validated template version first.",
      "template_version_not_approved"
    );
  }

  const existingProject = parsed.data.projectId
    ? await prisma.pipelineProject.findFirst({
        where: { id: parsed.data.projectId, studyId },
        include: { versions: { select: { id: true } } }
      })
    : null;
  const projectName = parsed.data.name ?? existingProject?.name ?? `${study.title} NVFLARE Pipeline`;
  const branchName =
    parsed.data.branchName ??
    `fedlify/${slugify(study.title).slice(0, 48)}-${Date.now().toString(36)}`;
  const repoName =
    existingProject?.giteaRepo ??
    pipelineProjectSlug(study.title, projectName, process.env.GITEA_PIPELINE_REPO_PREFIX ?? "pipeline");
  let files;
  const canReadTemplateSource =
    template.giteaOwner &&
    template.giteaRepo &&
    approvedTemplateVersion.gitCommit &&
    !approvedTemplateVersion.gitCommit.startsWith("legacy-seed-");
  if (canReadTemplateSource) {
    const templateFiles = await readGiteaRepositoryFiles({
      owner: template.giteaOwner!,
      repo: template.giteaRepo!,
      ref: approvedTemplateVersion.gitCommit
    });
    files = [
      ...templateFiles,
      {
        path: "fedlify-pipeline.json",
        content: JSON.stringify(
          {
            packageType: "fedlify-nvflare-pipeline",
            version: "1.0.0",
            projectName,
            study: {
              id: study.id,
              title: study.title,
              slug: study.slug,
              goal: study.goal,
              researchQuestion: study.researchQuestion,
              clinicalUseCase: study.clinicalUseCase,
              dataModalities: study.dataModalities,
              intendedUse: study.intendedUse
            },
            template: {
              id: template.id,
              name: template.name,
              key: template.templateKey,
              version: approvedTemplateVersion.version,
              gitCommit: approvedTemplateVersion.gitCommit
            },
            participants: study.studySites.map((site) => ({
              studySiteId: site.id,
              code: site.code,
              name: site.name,
              institutionName: site.institutionName,
              nvflareClientName: site.site?.nvflareClientName ?? `site-${site.code}`
            })),
            dataBoundary: "site-only",
            rawDataPolicy: "Do not commit raw clinical data, patient identifiers, extracts, or site-local dataset files.",
            requestedChange: parsed.data.prompt
          },
          null,
          2
        )
      }
    ];
  } else {
    files = await buildNvflareJobPipelineFiles({
      study,
      template,
      projectName,
      prompt: parsed.data.prompt,
      sites: study.studySites
    });
  }
  const validation = validatePipelineFiles(files);
  if (validation.status !== "PASSED") {
    return problem(422, validation.summary, "pipeline_validation_failed");
  }

  let gitea;
  try {
    const workspace = await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId });
    gitea = await createGiteaPipelineProposal({
      owner: workspace.owner,
      repoName,
      projectName,
      description: `Fedlify pipeline workspace for ${study.title}.`,
      branchName,
      files,
      pullRequestBody: [
        `Study: ${study.title}`,
        "",
        "This pull request was generated from a vetted Fedlify NVFLARE template.",
        "",
        "Fedlify validation summary:",
        validation.summary
      ].join("\n")
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const version = nextVersion(existingProject?.versions.length ?? 0);
  const artifactStorageKey = objectKey(["studies", studyId, "pipelines", repoName, version, "source-bundle.zip"]);
  let storageUploaded = false;
  let storageError: string | undefined;
  if (storageConfigured()) {
    try {
      const bundle = await zipFiles(filesToArchiveMap(files));
      await uploadObject(artifactStorageKey, bundle, "application/zip");
      storageUploaded = true;
    } catch (error) {
      storageError = error instanceof Error ? error.message : "Pipeline source bundle upload failed.";
    }
  }

  let result = await prisma.$transaction(async (tx) => {
    let project = existingProject;

    if (!project) {
      project = await tx.pipelineProject.create({
        data: {
          studyId,
          templateId: template.id,
          templateVersionId: approvedTemplateVersion.id,
          name: projectName,
          giteaRepoUrl: parsed.data.giteaRepoUrl ?? gitea.repoUrl,
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaDefaultBranch: gitea.baseBranch,
          defaultBranch: "main",
          status: "VALIDATING"
        },
        include: { versions: { select: { id: true } } }
      });
    }

    const pipelineVersion = await tx.pipelineVersion.create({
      data: {
        projectId: project.id,
        templateId: template.id,
        templateVersionId: approvedTemplateVersion.id,
        version,
        gitCommit: gitea.commitSha,
        gitBranch: gitea.branchName,
        artifactStorageKey,
        validationStatus: "PASSED",
        approvalStatus: "VALIDATED"
      }
    });

    const proposal = await tx.agentProposal.create({
      data: {
        projectId: project.id,
        requestedById: authResult.userId,
        prompt: parsed.data.prompt,
        branchName: gitea.branchName,
        giteaPullRequestUrl: gitea.pullRequestUrl,
        giteaPullRequestNumber: gitea.pullRequestNumber,
        giteaHeadCommit: gitea.commitSha,
        giteaBaseBranch: gitea.baseBranch,
        status: "OPEN",
        resultSummary: validation.summary
      }
    });

    const ciRun = await tx.cIValidationRun.create({
      data: {
        pipelineVersionId: pipelineVersion.id,
        agentProposalId: proposal.id,
        provider: "argo-gitea",
        workflowId: `pipeline-ci-${pipelineVersion.id}`,
        status: "PASSED",
        summary: storageError ? `${validation.summary} Source bundle upload warning: ${storageError}` : validation.summary,
        logsStorageKey: storageUploaded ? artifactStorageKey : null,
        completedAt: new Date()
      }
    });

    await tx.pipelineProject.update({
      where: { id: project.id },
      data: {
        status: "VALIDATED",
        giteaRepoUrl: gitea.repoUrl,
        giteaOwner: gitea.owner,
        giteaRepo: gitea.repo,
        giteaDefaultBranch: gitea.baseBranch
      }
    });

    return { project, pipelineVersion, proposal, ciRun };
  });

  const jobWorkspacePath = pipelineJobWorkspacePath({ studyId, pipelineVersionId: result.pipelineVersion.id });
  try {
    await writeNvflareJobWorkspace({ files, destination: jobWorkspacePath });
    result = {
      ...result,
      pipelineVersion: await prisma.pipelineVersion.update({
        where: { id: result.pipelineVersion.id },
        data: { jobWorkspacePath }
      })
    };
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "NVFLARE job workspace write failed.";
    await prisma.pipelineVersion.update({
      where: { id: result.pipelineVersion.id },
      data: { validationStatus: "FAILED" }
    });
    return problem(500, `Pipeline proposal was created, but the local NVFLARE job workspace was not prepared: ${lastError}`, "job_workspace_failed");
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "pipeline.agent_proposal.create",
    targetType: "PipelineVersion",
    targetId: result.pipelineVersion.id,
    metadata: {
      templateKey: template.templateKey,
      templateVersionId: approvedTemplateVersion.id,
      templateVersion: approvedTemplateVersion.version,
      branchName: result.proposal.branchName,
      validationStatus: result.ciRun.status,
      giteaRepo: `${gitea.owner}/${gitea.repo}`,
      giteaPullRequestNumber: gitea.pullRequestNumber,
      gitCommit: gitea.commitSha,
      jobWorkspacePath,
      storageUploaded,
      storageError
    },
    request
  });

  return json(result, { status: 201 });
}
