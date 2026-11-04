/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/import
 *
 * Bring your own code: a public Git URL (github.com, or a repository of this platform's Gitea) or the text files of
 * a zip the browser read. The server applies every rule itself (see lib/repo-import.ts): the browser's checks are a
 * preview only. Imported content is data; nothing in it is run. With dryRun the response is the alignment report and
 * nothing is created. Otherwise a new repository is created in the study's Gitea organization with the imported
 * files as the first commit, and the project records where it came from.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { commitGiteaFiles, ensureGiteaRepository, getGiteaBranch, getGiteaTag, GiteaApiError, isRuntimeConfigurationError, readGiteaRepositoryFiles } from "@/lib/gitea";
import { ensureStudyGiteaWorkspace, publicTemplateOwner } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { IMPORT_LIMITS, isCommitRef, type RepoFile } from "@/lib/pipeline-start";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { fetchPublicArchive, hostOf, ImportError, parseImportUrl, prepareImport, readZipFiles } from "@/lib/repo-import";
import { giteaConfig } from "@/lib/runtime-config";
import { slugify } from "@/lib/slug";

const name = z.string().trim().min(3).max(120);

/** Largest request body read at all: the zip files are text, capped at IMPORT_LIMITS.maxTotalBytes after prepareImport, but a body is cut off long before that. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const importSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    url: z.string().max(300),
    ref: z.string().trim().max(200).optional(),
    name: name.optional(),
    dryRun: z.boolean().optional(),
    acknowledgeBlocking: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("files"),
    name: name.optional(),
    dryRun: z.boolean().optional(),
    acknowledgeBlocking: z.boolean().optional(),
    // The same limits prepareImport applies; data-like files are dropped there, so a few more than maxFiles are tolerated.
    files: z
      .array(
        z.object({
          path: z.string().max(300),
          content: z.string().max(IMPORT_LIMITS.maxFileBytes),
        }),
      )
      .min(1)
      .max(IMPORT_LIMITS.maxFiles * 2)
      .refine((files) => files.reduce((sum, file) => sum + file.content.length, 0) <= IMPORT_LIMITS.maxTotalBytes, "The files are larger than the import limit."),
  }),
]);

/** Read the JSON body with a hard byte cap, before any parsing. Returns null when the body is too large. */
async function readCappedJson(request: NextRequest): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Rejections worth a record: someone probing sources, hosts or credentials. */
const AUDITED_REJECTIONS = new Set(["source_not_allowed", "host_not_allowed", "secrets_found", "redirect_blocked"]);

type Params = { params: Promise<{ studyId: string }> };

function starterSource(): { owner: string; repo: string } {
  const [owner, repo] = (process.env.FEDLIFY_STARTER_TEMPLATE?.trim() || `${publicTemplateOwner()}/fedlify-starter`).split("/");
  return { owner, repo };
}

function configuredGiteaHost(): string | null {
  try {
    return hostOf(giteaConfig().baseUrl);
  } catch {
    return null;
  }
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
  if (!rateLimit(`pipeline-import:${authResult.userId}`, 20, 60_000)) return problem(429, "Too many imports. Wait a minute and try again.", "rate_limited");

  const rawBody = await readCappedJson(request);
  if (rawBody === null) return problem(413, `The import is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`, "payload_too_large");
  const parsed = importSchema.safeParse(rawBody);
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid import request.");
  const body = parsed.data;
  if (!body.dryRun && !body.name) return problem(400, "Give the pipeline a name.", "name_required");

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    select: { id: true, orgId: true },
  });
  if (!study) return problem(404, "Study not found.", "not_found");

  // Metadata is codes, counts and paths only; imported content never reaches the audit log.
  const auditImport = async (action: string, metadata: Record<string, unknown>, targetId = studyId) => {
    try {
      await audit({
        actorUserId: authResult.userId,
        orgId: study.orgId,
        studyId,
        action,
        targetType: targetId === studyId ? "Study" : "PipelineProject",
        targetId,
        metadata,
        request,
      });
    } catch {
      // A failing audit write must not turn a refusal into a server error.
    }
  };

  let sourceRef = "";
  let prepared: ReturnType<typeof prepareImport>;
  let workspaceOwner: string | null = null;
  try {
    let raw: RepoFile[];
    let skipped: string[] = [];
    if (body.kind === "files") {
      raw = body.files;
      sourceRef = "zip:"; // completed with the content digest below
    } else {
      const source = parseImportUrl(body.url, body.ref, configuredGiteaHost());
      sourceRef = `${source.url}${source.ref ? `@${source.ref}` : ""}`;
      if (source.kind === "github") {
        const read = await readZipFiles(await fetchPublicArchive(source.archiveUrl));
        raw = read.files;
        skipped = read.skipped;
      } else {
        const workspace = await ensureStudyGiteaWorkspace({
          studyId,
          userId: authResult.userId,
        });
        if (workspace.status !== "ACTIVE") return problem(503, workspace.lastError ?? "Study Gitea workspace is unavailable.", "gitea_workspace_failed");
        workspaceOwner = workspace.owner;
        // The platform token can read every repository: only this study's and the public templates are importable.
        if (source.owner !== publicTemplateOwner() && source.owner !== workspace.owner) {
          throw new ImportError("Only repositories of this study or the Fedlify templates can be imported from this Git server.", 403, "source_not_allowed");
        }
        let commit: string;
        if (isCommitRef(source.ref ?? undefined)) commit = source.ref as string;
        else {
          const refName = source.ref ?? "main";
          try {
            const branch = await getGiteaBranch({
              owner: source.owner,
              repo: source.repo,
              branchName: refName,
            });
            commit = branch.commit?.id ?? branch.commit?.sha ?? "";
          } catch (error) {
            // The branches endpoint knows branches only; a tag is looked up on its own endpoint.
            if (!(error instanceof GiteaApiError) || error.status !== 404) throw error;
            const tag = await getGiteaTag({
              owner: source.owner,
              repo: source.repo,
              tagName: refName,
            });
            commit = tag.commit?.sha ?? tag.commit?.id ?? "";
            if (!commit) throw error;
          }
        }
        const read = await readGiteaRepositoryFiles({
          owner: source.owner,
          repo: source.repo,
          ref: commit || source.ref || "main",
        });
        raw = read.filter((file) => !file.unreadable).map(({ path, content }) => ({ path, content }));
        skipped = read.filter((file) => file.unreadable).map((file) => file.path);
        sourceRef = `${source.url}@${commit ? commit.slice(0, 12) : (source.ref ?? "main")}`;
      }
    }
    prepared = prepareImport(raw, skipped);
    if (body.kind === "files") sourceRef = `zip:${prepared.digest}`;
  } catch (error) {
    if (error instanceof ImportError) {
      if (AUDITED_REJECTIONS.has(error.code)) {
        await auditImport("pipeline_project.import_rejected", {
          code: error.code,
          origin: body.kind,
          sourceRef: sourceRef || undefined,
          paths: error.paths.slice(0, 10),
          dryRun: Boolean(body.dryRun),
        });
      }
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            paths: error.paths,
          },
        },
        { status: error.status },
      );
    }
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(error.status === 404 ? 404 : 502, `Gitea: ${error.message}`, error.status === 404 ? "source_not_found" : "gitea_api_error");
    throw error;
  }

  const summary = {
    fileCount: prepared.files.length,
    dropped: prepared.dropped.length,
    skipped: prepared.skipped.length,
  };
  // A git dry run still makes an outbound request (and may create the study workspace): leave a record of it.
  if (body.dryRun) {
    if (body.kind === "git")
      await auditImport("pipeline_project.import_preview", {
        origin: "git",
        sourceRef,
        ...summary,
        blocking: prepared.report.blocking.map((finding) => finding.id),
      });
    return json({ report: prepared.report, ...summary });
  }

  // The server does not publish anything, but it does not quietly create an unpublishable project either.
  const blockingIds = prepared.report.blocking.map((finding) => finding.id);
  if (blockingIds.length > 0 && !body.acknowledgeBlocking) {
    return json(
      {
        error: {
          code: "blocking_unacknowledged",
          message: "The import has blocking findings. Send acknowledgeBlocking to create it anyway; publish will refuse it until they are fixed.",
          blocking: blockingIds,
        },
        report: prepared.report,
      },
      { status: 422 },
    );
  }

  // The import is recorded against the seeded starter template; this route never creates template rows.
  const starter = starterSource();
  const template = await prisma.pipelineTemplate.findFirst({
    where: { giteaOwner: starter.owner, giteaRepo: starter.repo },
    select: { id: true },
  });
  if (!template) return problem(503, "The starter template is not set up on this server, so imports are unavailable.", "starter_template_missing");

  const projectName = body.name as string;
  const repoName = slugify(projectName).slice(0, 60) || "pipeline";
  let created;
  try {
    const workspace = await ensureStudyGiteaWorkspace({
      studyId,
      userId: authResult.userId,
    });
    if (workspace.status !== "ACTIVE") return problem(503, workspace.lastError ?? "Study Gitea workspace is unavailable.", "gitea_workspace_failed");
    workspaceOwner = workspace.owner;
    if (
      await prisma.pipelineProject.findFirst({
        where: { studyId, giteaOwner: workspace.owner, giteaRepo: repoName },
      })
    ) {
      return problem(409, `A project named ${repoName} already exists in this study.`, "project_exists");
    }
    const repo = await ensureGiteaRepository({
      owner: workspace.owner,
      repoName,
      description: `${projectName} (imported)`,
    });
    const user = await prisma.user.findUnique({
      where: { id: authResult.userId },
      select: { name: true, email: true },
    });
    const saved = await commitGiteaFiles({
      owner: repo.owner,
      repo: repo.repo,
      branchName: repo.defaultBranch,
      files: prepared.files,
      message: "Import existing pipeline code",
      author: user?.email ? { name: user.name ?? user.email, email: user.email } : undefined,
    });
    created = { repo, saved };
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, `Gitea: ${error.message}`, "gitea_api_error");
    throw error;
  }

  let project;
  try {
    project = await prisma.pipelineProject.create({
      data: {
        studyId,
        templateId: template.id,
        name: projectName,
        giteaOwner: created.repo.owner,
        giteaRepo: created.repo.repo,
        giteaRepoUrl: created.repo.repoUrl,
        giteaDefaultBranch: created.repo.defaultBranch,
        defaultBranch: created.repo.defaultBranch,
        status: "DRAFT",
        sourceKind: "import",
        sourceRef,
        parentProjectId: null,
        parentVersion: null,
      },
    });
  } catch {
    // The repository exists but has no project row: say so, with the repo name, instead of leaving it unexplained.
    const repoPath = `${created.repo.owner}/${created.repo.repo}`;
    await auditImport("pipeline_project.import_orphan_repo", {
      repo: repoPath,
      commitSha: created.saved.commitSha,
      sourceRef,
    });
    return problem(500, `The repository ${repoPath} was created but the project could not be recorded. Remove that repository before importing again.`, "project_record_failed");
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "pipeline_project.import",
    targetType: "PipelineProject",
    targetId: project.id,
    // Paths and counts only: imported content is never written to the audit log.
    metadata: {
      sourceKind: "import",
      sourceRef,
      origin: body.kind,
      ...summary,
      blocking: blockingIds,
      repo: `${created.repo.owner}/${created.repo.repo}`,
      commitSha: created.saved.commitSha,
      workspaceOwner,
    },
    request,
  });

  return json(
    {
      project,
      commitSha: created.saved.commitSha,
      report: prepared.report,
      blocking: blockingIds,
      publishable: blockingIds.length === 0,
      ...summary,
    },
    { status: 201 },
  );
}
