/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/[projectId]/save
 *
 * Save = one commit of the researcher's edited files to the project repo in Gitea.
 * No build and no aggregator; publishing a saved commit is a separate step.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { commitGiteaFiles, GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { isProhibitedDataPath } from "@/lib/pipeline-code";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const MAX_FILE_BYTES = 512 * 1024;

const filePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "" || part === ".git"), {
    message: "File paths must be relative and stay inside the repository."
  });

const saveSchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
  baseCommit: z.string().trim().regex(/^[a-f0-9]{7,64}$/i).optional(),
  files: z
    .array(
      z.object({
        path: filePathSchema,
        content: z
          .string()
          .refine((value) => Buffer.byteLength(value) <= MAX_FILE_BYTES, { message: "Files over 512 KB cannot be saved from the editor." })
          .nullable()
      })
    )
    .min(1)
    .max(200)
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = saveSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid save request.");

  const blocked = parsed.data.files.filter((file) => isProhibitedDataPath(file.path)).map((file) => file.path);
  if (blocked.length > 0) {
    return problem(422, `Data-like files cannot be saved to a pipeline repository: ${blocked.join(", ")}.`, "data_file_blocked");
  }

  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId }, include: { study: true } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  if (!project.giteaOwner || !project.giteaRepo) {
    return problem(409, "This pipeline project has no Gitea repository yet.", "gitea_repo_required");
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { name: true, email: true } });
  const author = user?.email ? { name: user.name ?? user.email, email: user.email } : undefined;

  let saved: Awaited<ReturnType<typeof commitGiteaFiles>>;
  try {
    saved = await commitGiteaFiles({
      owner: project.giteaOwner,
      repo: project.giteaRepo,
      branchName: project.defaultBranch,
      baseCommit: parsed.data.baseCommit,
      files: parsed.data.files,
      message: parsed.data.message ?? `Save from Fedlify editor (${parsed.data.files.length} file(s))`,
      author
    });
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) {
      if (error.status === 409) return problem(409, error.message, "save_conflict");
      return problem(502, `Gitea rejected the save: ${error.message}`, "gitea_api_error");
    }
    throw error;
  }

  if (saved.changed > 0) {
    await audit({
      actorUserId: authResult.userId,
      orgId: project.study.orgId,
      studyId,
      action: "pipeline_project.save",
      targetType: "PipelineProject",
      targetId: project.id,
      metadata: {
        commitSha: saved.commitSha,
        branch: project.defaultBranch,
        baseCommit: parsed.data.baseCommit,
        paths: parsed.data.files.map((file) => file.path)
      },
      request
    });
  }

  return json({ commitSha: saved.commitSha, changed: saved.changed, branch: project.defaultBranch });
}
