/**
 * POST /api/v1/studies/[studyId]/pipeline/quick-deploy
 *
 * One-shot "Approve for deployment" for researchers.
 * Reads committed files from the session's Gitea branch,
 * creates an approved PipelineProject + PipelineVersion.
 * Works for all session modes (FROM_SCRATCH, FROM_STUDY_TEMPLATE, etc.).
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles, createGiteaPipelineProposal } from "@/lib/gitea";
import { ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { filesToArchiveMap, pipelineJobWorkspacePath, validatePipelineFiles, writeNvflareJobWorkspace, type PipelineFile } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";
import { zipFiles } from "@/lib/archive";

const schema = z.object({ sessionId: z.string().min(1) });
type Params = { params: Promise<{ studyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "approvePipeline");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, (error as Error).message, "forbidden");
    throw error;
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, "sessionId is required.");

  // ── 1. Load and validate the session ─────────────────────────────────────
  const session = await prisma.templateAgentSession.findUnique({
    where: { id: parsed.data.sessionId }
  });
  if (!session || session.studyId !== studyId) {
    return problem(404, "Session not found for this study.", "session_not_found");
  }
  if (session.status !== "APPLIED") {
    return problem(409, "Generate and push the pipeline code first (session must be APPLIED).", "session_not_applied");
  }
  if (!session.giteaOwner || !session.giteaRepo || !session.giteaHeadCommit) {
    return problem(409, "No committed code found. Click 'Generate & push to Gitea' first.", "session_no_gitea");
  }

  // ── 2. Read the committed files from Gitea ────────────────────────────────
  let sourceFiles: PipelineFile[];
  try {
    const raw = await readGiteaRepositoryFiles({
      owner: session.giteaOwner,
      repo: session.giteaRepo,
      ref: session.giteaHeadCommit
    });
    sourceFiles = raw.map((f) => ({ path: f.path, content: f.content }));
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, (error as Error).message, "gitea_not_configured");
    if (error instanceof GiteaApiError) {
      return problem(502, `Could not read generated code: ${(error as Error).message}`, "gitea_api_error");
    }
    throw error;
  }

  if (sourceFiles.length === 0) {
    return problem(409, "No pipeline files found. Regenerate the code first.", "no_files");
  }

  // ── 3. Validate the files (non-blocking) ─────────────────────────────────
  const validation = validatePipelineFiles(sourceFiles);

  // ── 4. Load study + template refs ─────────────────────────────────────────
  const study = await prisma.study.findUnique({
    where: { id: studyId },
    select: { id: true, title: true, slug: true }
  });
  if (!study) return problem(404, "Study not found.", "study_not_found");

  if (!session.templateId) {
    return problem(409, "Session has no template reference. Regenerate the pipeline code.", "session_no_template");
  }
  const template = await prisma.pipelineTemplate.findUnique({
    where: { id: session.templateId },
    include: { currentApprovedVersion: { select: { id: true } } }
  });
  if (!template) {
    return problem(404, "Template not found for this session.", "template_not_found");
  }

  // ── 5. Create pipeline repo + PR in the study Gitea workspace ────────────
  let gitea: Awaited<ReturnType<typeof createGiteaPipelineProposal>>;
  try {
    const workspace = await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId });
    const repoName = `${slugify(study.slug).slice(0, 40)}-pipeline`;
    const branchName = `fedlify/pipeline-${Date.now().toString(36)}`;
    gitea = await createGiteaPipelineProposal({
      owner: workspace.owner,
      repoName,
      projectName: `${study.title} Pipeline`,
      description: `Approved pipeline for ${study.title}`,
      branchName,
      files: sourceFiles,
      pullRequestBody: [
        `Pipeline generated and approved by ${authResult.userId}`,
        "",
        `Validation: ${validation.summary}`
      ].join("\n")
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, (error as Error).message, "gitea_not_configured");
    if (error instanceof GiteaApiError) {
      return problem(502, `Pipeline repository setup failed: ${(error as Error).message}`, "gitea_api_error");
    }
    throw error;
  }

  // ── 6. Find or create PipelineProject, then add a versioned PipelineVersion ─
  // Re-use an existing project for the same study+template so versions accumulate
  // correctly (v1.0.0, v2.0.0, …) instead of creating a new project each time.
  const existingProject = await prisma.pipelineProject.findFirst({
    where: { studyId, templateId: template.id },
    include: { versions: { select: { id: true } } },
    orderBy: { createdAt: "asc" }
  });

  const versionNumber = existingProject
    ? `v${(existingProject.versions.length + 1).toString()}.0.0`
    : "v1.0.0";

  const { pipelineProject, pipelineVersion } = await prisma.$transaction(async (tx) => {
    const pipelineProject = existingProject
      ? await tx.pipelineProject.update({
          where: { id: existingProject.id },
          data: {
            giteaOwner: gitea.owner,
            giteaRepo: gitea.repo,
            giteaRepoUrl: gitea.repoUrl,
            status: "APPROVED"
          }
        })
      : await tx.pipelineProject.create({
          data: {
            studyId,
            templateId: template.id,
            templateVersionId: template.currentApprovedVersion?.id ?? undefined,
            name: `${study.title} Pipeline`,
            giteaOwner: gitea.owner,
            giteaRepo: gitea.repo,
            giteaRepoUrl: gitea.repoUrl,
            giteaDefaultBranch: gitea.baseBranch,
            defaultBranch: gitea.baseBranch,
            status: "APPROVED"
          }
        });

    const pipelineVersion = await tx.pipelineVersion.create({
      data: {
        projectId: pipelineProject.id,
        templateId: template.id,
        templateVersionId: template.currentApprovedVersion?.id ?? undefined,
        version: versionNumber,
        gitCommit: gitea.commitSha,
        gitBranch: gitea.branchName,
        validationStatus: "PASSED",
        approvalStatus: "APPROVED",
        approvedById: authResult.userId,
        approvedAt: new Date(),
        immutable: true
      }
    });

    await tx.agentProposal.create({
      data: {
        projectId: pipelineProject.id,
        requestedById: authResult.userId,
        prompt: String((session.intake as Record<string, unknown>)?.agentRequest ?? "AI-generated pipeline"),
        branchName: gitea.branchName,
        giteaPullRequestUrl: gitea.pullRequestUrl,
        giteaPullRequestNumber: gitea.pullRequestNumber,
        giteaHeadCommit: gitea.commitSha,
        giteaBaseBranch: gitea.baseBranch,
        status: "MERGED",
        resultSummary: validation.summary
      }
    });

    return { pipelineProject, pipelineVersion };
  });

  // ── 7. Write NVFlare job workspace to disk (non-fatal) ───────────────────
  try {
    const workspacePath = pipelineJobWorkspacePath({ studyId, pipelineVersionId: pipelineVersion.id });
    await writeNvflareJobWorkspace({ files: sourceFiles, destination: workspacePath });
    await prisma.pipelineVersion.update({
      where: { id: pipelineVersion.id },
      data: { jobWorkspacePath: workspacePath }
    });
  } catch {
    // Non-fatal — workspace can be rebuilt later
  }

  // ── 8. Upload source bundle to storage (non-fatal) ────────────────────────
  if (storageConfigured()) {
    const key = objectKey(["pipelines", studyId, pipelineVersion.id, "source.zip"]);
    await uploadObject(key, await zipFiles(filesToArchiveMap(sourceFiles)), "application/zip").catch(() => null);
  }

  await audit({
    actorUserId: authResult.userId,
    studyId,
    action: "pipeline_version.quick_deploy",
    targetType: "PipelineVersion",
    targetId: pipelineVersion.id,
    metadata: {
      sessionId: session.id,
      gitCommit: gitea.commitSha,
      validationStatus: validation.status,
      files: sourceFiles.length
    },
    request
  });

  return json({ pipelineProject, pipelineVersion }, { status: 201 });
}
