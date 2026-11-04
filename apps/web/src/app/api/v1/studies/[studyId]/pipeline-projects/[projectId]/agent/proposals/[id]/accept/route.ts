/**
 * POST .../agent/proposals/[id]/accept
 *
 * A human accepts (all or some of) a proposal: the files are re-validated against the branch head and committed
 * as one Gitea commit authored by the accepting user, with the agent named as co-author. A proposal written
 * against an older commit is marked STALE and answered with 409 so the client can offer to regenerate.
 * The assistant itself has no route that commits; this is the only one, and it needs a signed-in user with runAgent.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { agentCommitMessage, repoPathSchema, selectProposalFiles, validateProposalFiles } from "@/lib/agent-proposal";
import { markStale, readStoredFiles } from "@/lib/agent-proposal-store";
import { commitGiteaFiles, GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { loadProjectRepo } from "@/lib/project-repo";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const acceptSchema = z.object({ paths: z.array(repoPathSchema).min(1).max(200).optional() });

type Params = { params: Promise<{ studyId: string; projectId: string; id: string }> };

const STALE_MESSAGE = "The saved code changed after this proposal was written. Regenerate it against the latest commit.";

/** Best effort: bookkeeping after a commit must never turn a successful commit into an error response. */
async function settle<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt === 2) console.error(`agent accept: ${label} failed after the commit was written`, error instanceof Error ? error.message : "unknown error");
    }
  }
  return null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, id } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = acceptSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid accept request.");

  const repo = await loadProjectRepo(studyId, projectId);
  if (!repo.ok) return repo.response;
  const { project } = repo;
  if (!project.giteaOwner || !project.giteaRepo) return problem(409, "This pipeline project has no Gitea repository yet.", "gitea_repo_required");

  const refused = (reason: string, extra: Record<string, unknown> = {}) =>
    settle("refusal audit", () =>
      audit({
        actorUserId: authResult.userId,
        orgId: project.study.orgId,
        studyId,
        action: "pipeline_project.agent_accept_refused",
        targetType: "PipelineProject",
        targetId: project.id,
        metadata: { proposalId: id, reason, ...extra },
        request
      })
    );

  const row = await prisma.agentProposal.findFirst({ where: { id, projectId } });
  if (!row || row.files === null) return problem(404, "Proposal not found.", "not_found");
  if (row.status === "STALE") {
    await refused("stale", { baseCommit: row.baseCommit });
    return problem(409, STALE_MESSAGE, "proposal_stale");
  }
  if (row.status !== "PROPOSED") return problem(409, `This proposal is already ${row.status.toLowerCase()}.`, "proposal_not_open");

  if (!row.baseCommit || row.baseCommit !== repo.commit) {
    await markStale(row.id);
    await refused("stale", { baseCommit: row.baseCommit, head: repo.commit });
    return problem(409, STALE_MESSAGE, "proposal_stale");
  }

  const stored = readStoredFiles(row.files);
  const selected = selectProposalFiles(stored, parsed.data.paths);
  if (!selected.ok) return problem(400, selected.message);

  // Validate again against the head as it is now: the stored copy is not trusted just because it was checked once.
  const validation = validateProposalFiles(
    selected.files.map((file) => ({ path: file.path, content: file.content })),
    repo.files
  );
  if (!validation.ok) {
    await refused("invalid", { errors: validation.errors.slice(0, 20) });
    return json(
      { error: { code: "proposal_invalid", message: "These changes break a repository rule, so nothing was committed.", details: validation.errors.slice(0, 20) } },
      { status: 422 }
    );
  }

  // Claim the proposal so two accepts cannot commit it twice. It is released again if the commit fails.
  const claim = await prisma.agentProposal.updateMany({
    where: { id, projectId, status: "PROPOSED" },
    data: { status: "ACCEPTED", acceptedById: authResult.userId, decidedAt: new Date(), acceptedPaths: validation.files.map((file) => file.path) }
  });
  if (claim.count === 0) {
    await refused("claim_lost");
    return problem(409, "This proposal was already decided.", "proposal_not_open");
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { name: true, email: true } });
  const author = user?.email ? { name: user.name ?? user.email, email: user.email } : undefined;

  let saved: Awaited<ReturnType<typeof commitGiteaFiles>>;
  try {
    saved = await commitGiteaFiles({
      owner: project.giteaOwner,
      repo: project.giteaRepo,
      branchName: project.defaultBranch,
      baseCommit: row.baseCommit,
      files: validation.files.map((file) => ({ path: file.path, content: file.content })),
      message: agentCommitMessage({
        title: row.title ?? "Proposed change",
        proposalId: row.id,
        acceptedBy: user?.name ?? user?.email ?? authResult.userId,
        paths: validation.files.length
      }),
      author
    });
  } catch (error) {
    const stale = error instanceof GiteaApiError && error.status === 409;
    await prisma.agentProposal.updateMany({
      where: { id, status: "ACCEPTED", acceptedCommit: null },
      data: stale
        ? { status: "STALE", acceptedById: null }
        : { status: "PROPOSED", acceptedById: null, decidedAt: null }
    });
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (stale) return problem(409, STALE_MESSAGE, "proposal_stale");
    if (error instanceof GiteaApiError) return problem(502, `Gitea rejected the commit: ${error.message}`, "gitea_api_error");
    throw error;
  }

  // The commit exists from here on. Record it and audit it; neither failure may hide the commit from the caller.
  const metadata = {
    proposalId: row.id,
    contextHash: row.contextHash,
    commitSha: saved.commitSha,
    baseCommit: row.baseCommit,
    branch: project.defaultBranch,
    model: row.model,
    paths: validation.files.map((file) => file.path),
    partial: validation.files.length < stored.length
  };
  const recorded = await settle("record commit", () => prisma.agentProposal.update({ where: { id }, data: { acceptedCommit: saved.commitSha } }));
  const audited = await settle("audit", () =>
    audit({
      actorUserId: authResult.userId,
      orgId: project.study.orgId,
      studyId,
      action: "pipeline_project.agent_save",
      targetType: "PipelineProject",
      targetId: project.id,
      metadata: { ...metadata, commitRecorded: recorded !== null },
      request
    }).then(() => true)
  );
  if (recorded === null || audited === null) console.error(`agent accept: proposal ${row.id} committed ${saved.commitSha} but bookkeeping is incomplete (recorded=${recorded !== null}, audited=${audited !== null})`);

  return json({ commitSha: saved.commitSha, changed: saved.changed, branch: project.defaultBranch, proposal: { id: row.id, status: "ACCEPTED" } });
}
