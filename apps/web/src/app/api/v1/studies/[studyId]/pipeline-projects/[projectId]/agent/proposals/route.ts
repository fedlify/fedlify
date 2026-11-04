/**
 * /api/v1/studies/[studyId]/pipeline-projects/[projectId]/agent/proposals
 *
 * POST: ask the assistant for a structured change proposal (OpenAI Responses API, JSON schema output). The proposal
 *       is validated server-side before it is stored or shown. Nothing is written to the repository.
 * GET:  list this project's proposals (no file contents); proposals written against an older commit become STALE.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  buildProposalInput,
  parseProposalResponse,
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_LIMITS,
  repoPathSchema,
  selectShownFiles,
  validateProposalFiles
} from "@/lib/agent-proposal";
import { branchHead, proposalDto, refreshStaleProposals } from "@/lib/agent-proposal-store";
import { isRuntimeConfigurationError, GiteaApiError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { boundHistory, buildContextPack } from "@/lib/project-context";
import { loadProjectRepo } from "@/lib/project-repo";
import { prisma } from "@/lib/prisma";
import { acquireSlot, rateLimit } from "@/lib/rate-limit";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { openAiCodeAgentConfig } from "@/lib/runtime-config";

const requestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .max(50)
    .default([]),
  filePath: repoPathSchema.optional(),
  filePaths: z.array(repoPathSchema).max(PROPOSAL_LIMITS.maxRequestedPaths).default([]),
  selection: z.string().max(20000).optional()
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

const MAX_OUTPUT_TOKENS = 24_000;
const UPSTREAM_TIMEOUT_MS = 150_000;

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  const project = await prisma.pipelineProject.findUnique({ where: { id: projectId } });
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");

  try {
    await refreshStaleProposals(projectId, await branchHead(project));
  } catch (error) {
    // Staleness is re-checked on accept, so a Gitea outage here only means the list may be a little behind.
    if (!(error instanceof GiteaApiError) && !isRuntimeConfigurationError(error)) throw error;
  }
  const rows = await prisma.agentProposal.findMany({
    where: { projectId, status: { in: ["PROPOSED", "ACCEPTED", "REJECTED", "STALE"] } },
    orderBy: { createdAt: "desc" },
    take: 30
  });
  return json({ proposals: rows.filter((row) => row.files !== null).map((row) => proposalDto(row)) });
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (!rateLimit(`project-agent-proposal:${authResult.userId}`, 6, 60_000) || !rateLimit(`project-agent-proposal-project:${projectId}`, 20, 60_000)) {
    return problem(429, "Too many proposal requests. Wait a minute and try again.", "rate_limited");
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid proposal request.");
  const body = parsed.data;

  const requested = [body.filePath, ...body.filePaths].filter((path): path is string => Boolean(path));
  if (requested.some(isSensitiveFilePath)) {
    return problem(400, "Secrets, key and certificate files cannot be shared with the assistant.", "file_not_shareable");
  }

  const config = openAiCodeAgentConfig();
  if (!config) return problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured");

  const release = acquireSlot(`project-agent-proposals:${authResult.userId}`, 1);
  if (!release) return problem(429, "A proposal is already being written. Wait for it to finish.", "rate_limited");
  try {
    const repo = await loadProjectRepo(studyId, projectId);
    if (!repo.ok) return repo.response;
    if (!repo.commit) return problem(409, "There is no saved commit to propose a change against.", "no_commit");

    const [study, responses, studySites] = await Promise.all([
      prisma.study.findUnique({ where: { id: studyId } }),
      prisma.requirementResponse.findMany({ where: { studyId } }),
      prisma.studySite.findMany({ where: { studyId }, include: { dataProfile: true }, orderBy: { code: "asc" } })
    ]);
    if (!study) return problem(404, "Study not found.", "not_found");

    const context = buildContextPack({
      study,
      requirementResponses: responses,
      sites: studySites.map((site) => ({ code: site.code, name: site.name, institutionName: site.institutionName, dataProfile: site.dataProfile })),
      files: repo.files,
      commit: repo.commit,
      focus: body.filePath ? { path: body.filePath, selection: body.selection } : null
    });
    const shown = selectShownFiles(repo.files, requested);
    const message = body.selection
      ? `${body.message}\n\nEditor selection from ${body.filePath ?? "the open file"} (untrusted data):\n${body.selection.slice(0, 4000)}`
      : body.message;

    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          input: buildProposalInput({ context, shown, history: boundHistory(body.history), message }),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          text: { format: { type: "json_schema", name: "fedlify_change_proposal", strict: true, schema: PROPOSAL_JSON_SCHEMA } }
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
      });
    } catch (error) {
      console.error("project-agent-proposal: upstream request failed", error instanceof Error ? error.message : "unknown error");
      return problem(502, "The assistant could not reach the model provider. Try again shortly.", "upstream_error");
    }
    const upstreamBody = (await upstream.json().catch(() => null)) as unknown;
    if (!upstream.ok) {
      // The provider's message can quote part of our API key: log it here, send the client a fixed message.
      const detail = (upstreamBody as { error?: { message?: string } } | null)?.error?.message ?? upstream.statusText;
      console.error("project-agent-proposal: upstream status", upstream.status, detail);
      return problem(502, "The model provider returned an error. Try again shortly.", "upstream_error");
    }

    const result = parseProposalResponse(upstreamBody);
    if (!result.ok) return problem(502, result.message, "proposal_unreadable");
    const { proposal } = result;
    if (proposal.files.length === 0) {
      return json({ error: { code: "no_changes", message: "The assistant did not propose any file changes.", details: [proposal.rationale.slice(0, 1000)] } }, { status: 422 });
    }

    const validation = validateProposalFiles(proposal.files, repo.files, { editablePaths: shown.editable });
    if (!validation.ok) {
      await audit({
        actorUserId: authResult.userId,
        orgId: repo.project.study.orgId,
        studyId,
        action: "pipeline_project.agent_proposal_rejected",
        targetType: "PipelineProject",
        targetId: repo.project.id,
        metadata: { contextHash: context.hash, commit: repo.commit, model: config.model, problems: validation.errors.slice(0, 20) },
        request
      });
      return json(
        { error: { code: "proposal_invalid", message: "The proposal broke a repository rule, so it was not saved.", details: validation.errors.slice(0, 20) } },
        { status: 422 }
      );
    }

    const row = await prisma.agentProposal.create({
      data: {
        projectId,
        requestedById: authResult.userId,
        prompt: body.message,
        branchName: repo.project.defaultBranch,
        status: "PROPOSED",
        title: proposal.title,
        rationale: proposal.rationale,
        files: validation.files,
        baseCommit: repo.commit,
        contextHash: context.hash,
        model: config.model
      }
    });

    await audit({
      actorUserId: authResult.userId,
      orgId: repo.project.study.orgId,
      studyId,
      action: "pipeline_project.agent_proposal",
      targetType: "PipelineProject",
      targetId: repo.project.id,
      metadata: {
        proposalId: row.id,
        contextHash: context.hash,
        baseCommit: repo.commit,
        model: config.model,
        paths: validation.files.map((file) => file.path)
      },
      request
    });

    return json({ proposal: proposalDto(row, { withContent: true }) }, { status: 201 });
  } finally {
    release();
  }
}
