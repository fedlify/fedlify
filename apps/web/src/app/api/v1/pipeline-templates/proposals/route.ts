import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { zipFiles } from "@/lib/archive";
import { audit } from "@/lib/audit";
import { ensurePublicTemplateWorkspace, ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { createGiteaTemplateProposal, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import {
  buildTemplateRepositoryFiles,
  templateKeyForName,
  templateRepoName,
  validateTemplateIntake,
  validateTemplateRepositoryFiles,
  type TemplateIntakeAnswers
} from "@/lib/pipeline-template-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { filesToArchiveMap } from "@/lib/pipeline-code";
import type { PipelineFile } from "@/lib/pipeline-code";
import { parseSourceRef } from "@/lib/source-review";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";

const intakeSchema = z.object({
  purpose: z.string().trim().min(3),
  clinicalUseCase: z.string().trim().min(3),
  dataModalities: z.array(z.string().trim().min(1)).min(1),
  siteLocalInputs: z.string().trim().min(3),
  syntheticFixtures: z.string().trim().min(3),
  nvflareWorkflow: z.string().trim().min(3),
  minClients: z.coerce.number().int().min(1),
  numRounds: z.coerce.number().int().min(1),
  aggregation: z.string().trim().min(3),
  privacyConstraints: z.string().trim().min(3),
  dependencyPolicy: z.string().trim().min(3),
  artifactOutputs: z.string().trim().min(3),
  reviewExpectations: z.string().trim().min(3)
});

const proposalSchema = z.object({
  kind: z.enum(["NEW_TEMPLATE", "CHANGE_TEMPLATE"]).default("NEW_TEMPLATE"),
  scope: z.enum(["PUBLIC_TEMPLATE", "STUDY_TEMPLATE"]).optional(),
  studyId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  sourceRef: z.string().trim().max(200).optional(),
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  prompt: z.string().trim().min(20).max(12000),
  intakeAnswers: intakeSchema,
  branchName: z.string().trim().min(3).max(160).optional(),
  fileChanges: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(500),
        content: z.string().max(1_000_000)
      })
    )
    .max(20)
    .optional()
});

async function userCanProposeTemplate(userId: string, studyId?: string) {
  if (studyId) {
    await assertStudyAccess(userId, studyId, "runAgent");
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
  if (user?.platformRole === "PLATFORM_ADMIN") return;
  const canPropose = await prisma.studyMember.findFirst({
    where: { userId, role: { in: ["PIPELINE_DEVELOPER", "DATA_SCIENTIST", "PRINCIPAL_INVESTIGATOR", "STUDY_OWNER"] } },
    select: { id: true }
  });
  if (canPropose) return;
  const error = new Error("You do not have permission to propose reusable templates.");
  error.name = "ForbiddenError";
  throw error;
}

function isSafeTemplatePath(filePath: string) {
  return (
    filePath.length > 0 &&
    !filePath.startsWith("/") &&
    !filePath.includes("\\") &&
    !filePath.split("/").includes("..") &&
    !filePath.split("/").includes(".git")
  );
}

function applyFileChanges(files: PipelineFile[], fileChanges?: Array<{ path: string; content: string }>) {
  if (!fileChanges?.length) return files;
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const change of fileChanges) {
    if (!isSafeTemplatePath(change.path)) {
      const error = new Error(`Unsafe template file path: ${change.path}`);
      error.name = "UnsafeTemplatePathError";
      throw error;
    }
    byPath.set(change.path, { path: change.path, content: change.content });
  }
  return [...byPath.values()].sort((first, second) => first.path.localeCompare(second.path));
}

async function readTemplateSourceForChange(input: {
  templateId: string;
  owner?: string | null;
  repo?: string | null;
  defaultBranch?: string | null;
  currentApprovedCommit?: string | null;
  sourceRef?: string | null;
}) {
  if (!input.owner || !input.repo) return null;
  const parsedRef = parseSourceRef(input.sourceRef);
  let gitRef = input.currentApprovedCommit ?? input.defaultBranch ?? "main";

  if (parsedRef.kind === "version") {
    const version = await prisma.pipelineTemplateVersion.findFirst({
      where: { id: parsedRef.id, templateId: input.templateId },
      select: { gitCommit: true }
    });
    if (version?.gitCommit) gitRef = version.gitCommit;
  }

  if (parsedRef.kind === "proposal") {
    const proposal = await prisma.templateProposal.findFirst({
      where: { id: parsedRef.id, templateId: input.templateId },
      select: { branchName: true }
    });
    if (proposal?.branchName) gitRef = proposal.branchName;
  }

  return readGiteaRepositoryFiles({ owner: input.owner, repo: input.repo, ref: gitRef });
}

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const parsed = proposalSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid template proposal.");

  try {
    await userCanProposeTemplate(authResult.userId, parsed.data.studyId);
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const intakeErrors = validateTemplateIntake(parsed.data.intakeAnswers as TemplateIntakeAnswers);
  if (intakeErrors.length > 0) return problem(400, intakeErrors.join(" "), "template_intake_incomplete");

  const existingTemplate =
    parsed.data.kind === "CHANGE_TEMPLATE" && parsed.data.templateId
      ? await prisma.pipelineTemplate.findUnique({
          where: { id: parsed.data.templateId },
          include: { currentApprovedVersion: true, templateVersions: true }
        })
      : null;
  if (parsed.data.kind === "CHANGE_TEMPLATE" && !existingTemplate) {
    return problem(404, "Template to change was not found.", "template_not_found");
  }
  const requestedScope = parsed.data.scope ?? (existingTemplate?.scope === "STUDY_TEMPLATE" || parsed.data.studyId ? "STUDY_TEMPLATE" : "PUBLIC_TEMPLATE");
  const studyId = parsed.data.studyId ?? existingTemplate?.studyId ?? undefined;
  if (requestedScope === "STUDY_TEMPLATE" && !studyId) {
    return problem(400, "Study-scoped template proposals require a study.", "study_required");
  }

  const templateKey = existingTemplate?.templateKey ?? templateKeyForName(parsed.data.name);
  const repoName = existingTemplate?.giteaRepo ?? templateRepoName(parsed.data.name);
  const branchName = parsed.data.branchName ?? `fedlify/template-${slugify(parsed.data.name).slice(0, 42)}-${Date.now().toString(36)}`;
  let files = await buildTemplateRepositoryFiles({
    name: parsed.data.name,
    templateKey,
    description: parsed.data.description,
    prompt: parsed.data.prompt,
    intake: parsed.data.intakeAnswers as TemplateIntakeAnswers
  });

  if (existingTemplate && parsed.data.fileChanges?.length) {
    try {
      const sourceFiles = await readTemplateSourceForChange({
        templateId: existingTemplate.id,
        owner: existingTemplate.giteaOwner,
        repo: existingTemplate.giteaRepo,
        defaultBranch: existingTemplate.giteaDefaultBranch,
        currentApprovedCommit: existingTemplate.currentApprovedVersion?.gitCommit,
        sourceRef: parsed.data.sourceRef
      });
      if (sourceFiles?.length) {
        files = sourceFiles;
      }
    } catch (error) {
      if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
      if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
      throw error;
    }
  }

  try {
    files = applyFileChanges(files, parsed.data.fileChanges);
  } catch (error) {
    return problem(400, error instanceof Error ? error.message : "Invalid template file change.", "invalid_template_file_change");
  }
  const validation = validateTemplateRepositoryFiles(files);
  if (validation.status !== "PASSED") return problem(422, validation.summary, "template_validation_failed");

  let owner = existingTemplate?.giteaOwner ?? null;
  if (!owner) {
    try {
      owner =
        requestedScope === "STUDY_TEMPLATE" && studyId
          ? (await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId })).owner
          : (await ensurePublicTemplateWorkspace()).owner;
    } catch (error) {
      if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
      if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
      throw error;
    }
  }

  let gitea;
  try {
    gitea = await createGiteaTemplateProposal({
      owner,
      repoName,
      templateName: parsed.data.name,
      description: parsed.data.description ?? `Fedlify NVFLARE template: ${parsed.data.name}`,
      branchName,
      files,
      pullRequestBody: [
        `Template: ${parsed.data.name}`,
        `Kind: ${parsed.data.kind}`,
        "",
        "This draft pull request was generated by the Fedlify Codex template workflow.",
        "",
        "Validation summary:",
        validation.summary
      ].join("\n")
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const artifactStorageKey = objectKey(["templates", repoName, branchName.replaceAll("/", "-"), "source-bundle.zip"]);
  let storageUploaded = false;
  let storageError: string | undefined;
  if (storageConfigured()) {
    try {
      await uploadObject(artifactStorageKey, await zipFiles(filesToArchiveMap(files)), "application/zip");
      storageUploaded = true;
    } catch (error) {
      storageError = error instanceof Error ? error.message : "Template source bundle upload failed.";
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const template =
      existingTemplate ??
      (await tx.pipelineTemplate.create({
        data: {
          name: parsed.data.name,
          templateKey,
          framework: "nvflare",
          description: parsed.data.description,
          version: "1.0.0",
          spec: parsed.data.intakeAnswers,
          active: true,
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch,
          scope: requestedScope,
          studyId: requestedScope === "STUDY_TEMPLATE" ? studyId : null,
          createdById: authResult.userId
        }
      }));

    if (existingTemplate) {
      await tx.pipelineTemplate.update({
        where: { id: existingTemplate.id },
        data: {
          name: parsed.data.name,
          description: parsed.data.description,
          spec: parsed.data.intakeAnswers,
          status: "VALIDATED",
          giteaOwner: gitea.owner,
          giteaRepo: gitea.repo,
          giteaRepoUrl: gitea.repoUrl,
          giteaDefaultBranch: gitea.baseBranch,
          scope: requestedScope,
          studyId: requestedScope === "STUDY_TEMPLATE" ? studyId : null
        }
      });
    }

    const proposal = await tx.templateProposal.create({
      data: {
        templateId: template.id,
        requestedById: authResult.userId,
        kind: parsed.data.kind,
        intakeAnswers: parsed.data.intakeAnswers,
        prompt: parsed.data.prompt,
        branchName: gitea.branchName,
        giteaPullRequestUrl: gitea.pullRequestUrl,
        giteaPullRequestNumber: gitea.pullRequestNumber,
        giteaHeadCommit: gitea.commitSha,
        giteaBaseBranch: gitea.baseBranch,
        status: "OPEN",
        validationStatus: "PASSED",
        resultSummary: storageError ? `${validation.summary} Source bundle upload warning: ${storageError}` : validation.summary
      }
    });

    return { template, proposal };
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: null,
    studyId: parsed.data.studyId,
    action: "pipeline_template.proposal.create",
    targetType: "TemplateProposal",
    targetId: result.proposal.id,
    metadata: {
      templateId: result.template.id,
      kind: parsed.data.kind,
      giteaRepo: `${gitea.owner}/${gitea.repo}`,
      giteaPullRequestNumber: gitea.pullRequestNumber,
      gitCommit: gitea.commitSha,
      storageUploaded,
      storageError
    },
    request
  });

  return json(result, { status: 201 });
}
