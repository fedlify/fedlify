/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/clone
 *
 * Start a project: copy a main repository (the Fedlify starter or another approved template, or a repo of this
 * study) into a new repo in the study's Gitea org. Every later Save commits to that copy; Publish runs it.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { commitGiteaFiles, ensureGiteaRepository, getGiteaBranch, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { ensureStudyGiteaWorkspace, publicTemplateOwner } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { isProhibitedDataPath } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { slugify } from "@/lib/slug";

const repoPart = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/);

const cloneSchema = z.object({
  name: z.string().trim().min(3).max(120),
  source: z.object({ owner: repoPart, repo: repoPart, ref: z.string().trim().min(1).max(200).optional() }).optional()
});

type Params = { params: Promise<{ studyId: string }> };

function starterSource(): { owner: string; repo: string; ref?: string } {
  const [owner, repo] = (process.env.FEDLIFY_STARTER_TEMPLATE?.trim() || `${publicTemplateOwner()}/fedlify-starter`).split("/");
  return { owner, repo };
}

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

  const parsed = cloneSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid clone request.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { id: true, orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const source = parsed.data.source ?? starterSource();
  const repoName = `${slugify(parsed.data.name).slice(0, 60) || "pipeline"}`;

  let created;
  try {
    const workspace = await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId });
    if (workspace.status !== "ACTIVE") return problem(503, workspace.lastError ?? "Study Gitea workspace is unavailable.", "gitea_workspace_failed");

    // The platform token can read every repo, so restrict sources explicitly: templates or this study only.
    if (source.owner !== publicTemplateOwner() && source.owner !== workspace.owner) {
      return problem(403, "Projects can be cloned from Fedlify templates or from repositories of this study only.", "source_not_allowed");
    }
    if (await prisma.pipelineProject.findFirst({ where: { studyId, giteaOwner: workspace.owner, giteaRepo: repoName } })) {
      return problem(409, `A project named ${repoName} already exists in this study.`, "project_exists");
    }

    const sourceBranch = await getGiteaBranch({ owner: source.owner, repo: source.repo, branchName: source.ref ?? "main" });
    const sourceCommit = sourceBranch.commit?.id ?? sourceBranch.commit?.sha ?? "";
    const files = (await readGiteaRepositoryFiles({ owner: source.owner, repo: source.repo, ref: sourceCommit || source.ref || "main" })).filter(
      (file) => !isProhibitedDataPath(file.path)
    );
    if (files.length === 0) return problem(409, "The source repository has no files.", "empty_source");

    const repo = await ensureGiteaRepository({
      owner: workspace.owner,
      repoName,
      description: `${parsed.data.name} (cloned from ${source.owner}/${source.repo})`
    });
    const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { name: true, email: true } });
    const saved = await commitGiteaFiles({
      owner: repo.owner,
      repo: repo.repo,
      branchName: repo.defaultBranch,
      files,
      message: `Clone ${source.owner}/${source.repo}@${sourceCommit.slice(0, 12)}`,
      author: user?.email ? { name: user.name ?? user.email, email: user.email } : undefined
    });
    created = { repo, saved, sourceCommit };
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) {
      return problem(error.status === 404 ? 404 : 502, `Gitea: ${error.message}`, error.status === 404 ? "source_not_found" : "gitea_api_error");
    }
    throw error;
  }

  const template =
    (await prisma.pipelineTemplate.findFirst({ where: { giteaOwner: source.owner, giteaRepo: source.repo } })) ??
    (await prisma.pipelineTemplate.create({
      data: {
        name: `${source.owner}/${source.repo}`,
        templateKey: slugify(`${source.owner}-${source.repo}`),
        scope: source.owner === publicTemplateOwner() ? "PUBLIC_TEMPLATE" : "STUDY_PIPELINE",
        studyId: source.owner === publicTemplateOwner() ? null : studyId,
        spec: { packageType: "fedlify-study-pipeline", source },
        giteaOwner: source.owner,
        giteaRepo: source.repo,
        status: "APPROVED",
        createdById: authResult.userId
      }
    }));

  const project = await prisma.pipelineProject.create({
    data: {
      studyId,
      templateId: template.id,
      name: parsed.data.name,
      giteaOwner: created.repo.owner,
      giteaRepo: created.repo.repo,
      giteaRepoUrl: created.repo.repoUrl,
      giteaDefaultBranch: created.repo.defaultBranch,
      defaultBranch: created.repo.defaultBranch,
      status: "DRAFT"
    }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "pipeline_project.clone",
    targetType: "PipelineProject",
    targetId: project.id,
    metadata: { source, sourceCommit: created.sourceCommit, repo: `${created.repo.owner}/${created.repo.repo}`, commitSha: created.saved.commitSha },
    request
  });

  return json({ project, commitSha: created.saved.commitSha }, { status: 201 });
}
