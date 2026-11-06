/**
 * Creating a change proposal (shared by POST proposals and POST threads/[tid]/plans/[pid]/code).
 *
 * Without a thread this is the original stateless flow. With a thread the request is stored as turns, and with a
 * plan the plan must be APPROVED, current (same head and requirements) and not yet used. Nothing is written to the
 * repository here; accept stays the only route that commits.
 */

import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import {
  buildProposalInput,
  parseProposalResponse,
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_LIMITS,
  selectShownFiles,
  validateProposalFiles
} from "@/lib/agent-proposal";
import { approvedPaths, outsidePlanPaths, planCodeSection, planStaleness, questionState, requirementsHash } from "@/lib/agent-plan";
import { proposalDto } from "@/lib/agent-proposal-store";
import { accessFor, resolveActor } from "@/lib/agent-thread-access";
import { appendTurn, getPlanInThread, getThreadInProject, loadHistory, planDto, transitionPlan, turnDto } from "@/lib/agent-thread-store";
import { THREAD_ERROR_CODES, type EditorSelection } from "@/lib/agent-thread-types";
import { threadsDisabledResponse } from "@/lib/agent-thread-route";
import { loadDiagnosticsForMessage } from "@/lib/diagnostics-access";
import { json, problem } from "@/lib/json";
import { boundHistory, buildContextPack, type ChatTurn } from "@/lib/project-context";
import { loadProjectRepo } from "@/lib/project-repo";
import { prisma } from "@/lib/prisma";
import { acquireSlot, rateLimit } from "@/lib/rate-limit";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { agentThreadsEnabled, openAiCodeAgentConfig } from "@/lib/runtime-config";

const MAX_OUTPUT_TOKENS = 24_000;
const UPSTREAM_TIMEOUT_MS = 150_000;

export type ProposalRunInput = {
  request: NextRequest;
  userId: string;
  studyId: string;
  projectId: string;
  message: string;
  history: ChatTurn[];
  filePath?: string;
  filePaths: string[];
  selection?: string;
  selectionRange?: EditorSelection | null;
  diagnostics?: boolean;
  threadId?: string;
  planId?: string;
  clientTurnId?: string;
};

export async function runProposal(input: ProposalRunInput): Promise<Response> {
  const { request, userId, studyId, projectId } = input;

  const requested = [input.filePath, ...input.filePaths].filter((path): path is string => Boolean(path));
  if (requested.some(isSensitiveFilePath)) {
    return problem(400, "Secrets, key and certificate files cannot be shared with the assistant.", "file_not_shareable");
  }

  // ---- thread and plan gates (before any model call) ----
  let thread: NonNullable<Awaited<ReturnType<typeof getThreadInProject>>> | null = null;
  let plan: NonNullable<Awaited<ReturnType<typeof getPlanInThread>>> | null = null;
  if (input.threadId || input.planId) {
    if (!agentThreadsEnabled()) return threadsDisabledResponse();
    let threadId = input.threadId;
    if (input.planId) {
      const planRow = await prisma.agentPlan.findFirst({ where: { id: input.planId } });
      if (!planRow || (threadId && planRow.threadId !== threadId)) return problem(404, "Plan not found.", "not_found");
      threadId = planRow.threadId;
    }
    thread = threadId ? await getThreadInProject(projectId, threadId) : null;
    if (!thread || thread.studyId !== studyId) return problem(404, "Thread not found.", "not_found");
    const access = accessFor(await resolveActor(userId, studyId), userId, thread);
    if (!access) return problem(404, "Thread not found.", "not_found");
    if (!access.canWrite) return problem(403, "This thread is read-only for you.", THREAD_ERROR_CODES.readOnly);
    if (thread.status === "ARCHIVED") return problem(409, "This thread is archived.", THREAD_ERROR_CODES.threadArchived);
    if (input.planId) {
      plan = await getPlanInThread(thread.id, input.planId);
      if (!plan) return problem(404, "Plan not found.", "not_found");
      if (plan.status === "STALE") return problem(409, "The saved code or the study requirements changed after this plan was written. Plan again.", THREAD_ERROR_CODES.planStale);
      if (plan.status !== "APPROVED") return problem(409, "The plan must be approved before code is written.", THREAD_ERROR_CODES.planNotApproved);
    } else if (thread.mode !== "ask") {
      // Plan and Agent mode never produce code without an approved plan.
      return problem(409, "This thread is in plan mode. Approve a plan before code is written.", THREAD_ERROR_CODES.planNotApproved);
    }
  }

  if (!rateLimit(`project-agent-proposal:${userId}`, 6, 60_000) || !rateLimit(`project-agent-proposal-project:${projectId}`, 20, 60_000)) {
    return problem(429, "Too many proposal requests. Wait a minute and try again.", "rate_limited");
  }

  const config = openAiCodeAgentConfig();
  if (!config) return problem(503, "The assistant is not configured. Set OPENAI_API_KEY to enable it.", "ai_not_configured");

  const release = acquireSlot(`project-agent-proposals:${userId}`, 1);
  if (!release) return problem(429, "A proposal is already being written. Wait for it to finish.", "rate_limited");

  let claimedPlanId: string | null = null;
  let succeeded = false;
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

    if (plan) {
      const staleness = planStaleness(plan, { head: repo.commit, requirementsHash: requirementsHash(responses) });
      if (staleness) {
        await transitionPlan(plan.id, ["DRAFT", "APPROVED"], "STALE");
        return problem(409, "The saved code or the study requirements changed after this plan was written. Plan again.", THREAD_ERROR_CODES.planStale);
      }
      // Claim the plan so two code requests cannot both write against it. It is released again if no proposal results.
      if (!(await transitionPlan(plan.id, ["APPROVED"], "EXECUTED"))) return problem(409, "This plan was already used.", THREAD_ERROR_CODES.planNotApproved);
      claimedPlanId = plan.id;
    }

    const diagnostics = await loadDiagnosticsForMessage({ userId, studyId, projectId, message: input.message, flagged: input.diagnostics });
    const context = buildContextPack({
      study,
      requirementResponses: responses,
      sites: studySites.map((site) => ({ code: site.code, name: site.name, institutionName: site.institutionName, dataProfile: site.dataProfile })),
      files: repo.files,
      commit: repo.commit,
      focus: input.filePath ? { path: input.filePath, selection: input.selection } : null,
      diagnostics
    });

    // The approved plan's paths are shown to the model in full, ahead of other files.
    const planView = plan ? planDto(plan) : null;
    const planPaths = planView ? approvedPaths(planView, planView.approvedStepIds) : [];
    const shownRequest = [...new Set([...requested, ...planPaths.filter((path) => repo.files.some((file) => file.path === path))])].slice(0, PROPOSAL_LIMITS.maxRequestedPaths);
    const shown = selectShownFiles(repo.files, shownRequest);

    let message = input.selection
      ? `${input.message}\n\nEditor selection from ${input.filePath ?? "the open file"} (untrusted data):\n${input.selection.slice(0, 4000)}`
      : input.message;
    if (planView && thread) {
      const dto = planView;
      const qa = questionState(await prisma.agentTurn.findMany({ where: { threadId: thread.id, kind: { in: ["QUESTIONS", "ANSWERS", "PLAN"] } }, orderBy: { seq: "asc" }, select: { id: true, seq: true, kind: true, payload: true } })).qa;
      message = `${message}\n\n${planCodeSection({ plan: dto, approvedStepIds: dto.approvedStepIds, qa })}`;
    }

    // Store the request before the model is called; if that fails the model is not called.
    let userSeq: number | undefined;
    if (thread && !plan) {
      try {
        const appended = await appendTurn({ threadId: thread.id, role: "USER", content: input.message, actorUserId: userId, clientTurnId: input.clientTurnId ?? null, filePath: input.filePath ?? null, selection: input.selectionRange ?? null });
        if (appended.duplicate) return json({ duplicate: true, turn: turnDto(appended.turn) });
        userSeq = appended.turn.seq;
      } catch (error) {
        console.error("agent thread: could not store the turn", error instanceof Error ? error.message : "unknown error");
        return problem(500, "The request could not be saved, so the assistant was not called.", "persist_failed");
      }
    }
    const history = thread ? boundHistory(await loadHistory(thread.id, userSeq ? { beforeSeq: userSeq } : {})) : boundHistory(input.history);

    // Notes in the thread are best effort for failures, but required for a stored proposal (see below).
    const note = async (kind: "NOTICE" | "MESSAGE", content: string) => {
      if (!thread) return;
      await appendTurn({ threadId: thread.id, role: "ASSISTANT", kind, content, model: config.model, contextHash: context.hash, baseCommit: repo.commit, planId: plan?.id ?? null }).catch(() => undefined);
    };

    let upstream: Response;
    try {
      upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          input: buildProposalInput({ context, shown, history, message }),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          text: { format: { type: "json_schema", name: "fedlify_change_proposal", strict: true, schema: PROPOSAL_JSON_SCHEMA } }
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
      });
    } catch (error) {
      console.error("project-agent-proposal: upstream request failed", error instanceof Error ? error.message : "unknown error");
      await note("NOTICE", "The assistant could not reach the model provider.");
      return problem(502, "The assistant could not reach the model provider. Try again shortly.", "upstream_error");
    }
    const upstreamBody = (await upstream.json().catch(() => null)) as unknown;
    if (!upstream.ok) {
      const detail = (upstreamBody as { error?: { message?: string } } | null)?.error?.message ?? upstream.statusText;
      console.error("project-agent-proposal: upstream status", upstream.status, detail);
      await note("NOTICE", "The model provider returned an error.");
      return problem(502, "The model provider returned an error. Try again shortly.", "upstream_error");
    }

    const result = parseProposalResponse(upstreamBody);
    if (!result.ok) {
      await note("NOTICE", result.message);
      return problem(502, result.message, "proposal_unreadable");
    }
    const { proposal } = result;
    if (proposal.files.length === 0) {
      await note("MESSAGE", proposal.rationale.slice(0, 4000));
      return json({ error: { code: "no_changes", message: "The assistant did not propose any file changes.", details: [proposal.rationale.slice(0, 1000)] } }, { status: 422 });
    }

    const validation = validateProposalFiles(proposal.files, repo.files, { editablePaths: shown.editable });
    if (!validation.ok) {
      await audit({
        actorUserId: userId,
        orgId: repo.project.study.orgId,
        studyId,
        action: "pipeline_project.agent_proposal_rejected",
        targetType: "PipelineProject",
        targetId: repo.project.id,
        metadata: { contextHash: context.hash, commit: repo.commit, model: config.model, problems: validation.errors.slice(0, 20), ...(thread ? { threadId: thread.id } : {}), ...(plan ? { planId: plan.id } : {}) },
        request
      });
      await note("NOTICE", `The proposal broke a repository rule, so it was not saved: ${validation.errors.slice(0, 5).join(" ")}`);
      return json(
        { error: { code: "proposal_invalid", message: "The proposal broke a repository rule, so it was not saved.", details: validation.errors.slice(0, 20) } },
        { status: 422 }
      );
    }

    const outside = plan ? outsidePlanPaths(validation.files.map((file) => file.path), planPaths) : [];
    const rationale = outside.length > 0 ? `Outside the approved plan: ${outside.join(", ")}.\n\n${proposal.rationale}` : proposal.rationale;

    const row = await prisma.agentProposal.create({
      data: {
        projectId,
        requestedById: userId,
        prompt: input.message,
        branchName: repo.project.defaultBranch,
        status: "PROPOSED",
        title: proposal.title,
        rationale,
        files: validation.files,
        baseCommit: repo.commit,
        contextHash: context.hash,
        model: config.model,
        ...(thread ? { threadId: thread.id } : {}),
        ...(plan ? { planId: plan.id } : {})
      }
    });

    let proposalTurn: TurnRowLike | null = null;
    if (thread) {
      // The proposal and its turn go together: without the turn the proposal would be invisible in the thread.
      try {
        proposalTurn = (await appendTurn({ threadId: thread.id, role: "ASSISTANT", kind: "PROPOSAL", content: "", payload: { proposalId: row.id }, proposalId: row.id, planId: plan?.id ?? null, model: config.model, contextHash: context.hash, baseCommit: repo.commit })).turn;
        await prisma.agentProposal.update({ where: { id: row.id }, data: { turnId: proposalTurn.id } });
      } catch (error) {
        await prisma.agentProposal.delete({ where: { id: row.id } }).catch(() => undefined);
        console.error("agent thread: could not store the proposal turn", error instanceof Error ? error.message : "unknown error");
        return problem(500, "The proposal could not be saved.", "persist_failed");
      }
    }
    succeeded = true;

    await audit({
      actorUserId: userId,
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
        paths: validation.files.map((file) => file.path),
        diagnosticsIncluded: diagnostics !== null,
        ...(thread ? { threadId: thread.id } : {}),
        ...(plan ? { planId: plan.id, outsidePlanPaths: outside } : {})
      },
      request
    });

    return json(
      { proposal: proposalDto({ ...row, turnId: proposalTurn?.id ?? null }, { withContent: true }), outsidePlanPaths: outside, ...(proposalTurn ? { turn: turnDto(proposalTurn) } : {}) },
      { status: 201 }
    );
  } finally {
    if (claimedPlanId && !succeeded) await transitionPlan(claimedPlanId, ["EXECUTED"], "APPROVED").catch(() => undefined);
    release();
  }
}

type TurnRowLike = Awaited<ReturnType<typeof appendTurn>>["turn"];
