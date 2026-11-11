/**
 * POST .../agent/threads/[tid]/plans/[pid]/decision
 *
 * The thread's author approves or rejects a draft plan. This is recorded intent, not a governance approval: the diff
 * review, approvePipeline, publish and CI are unchanged.
 * Approval is refused with 409 plan_stale when the branch head or the answered study requirements changed since the plan
 * was written (the plan then becomes STALE), and with 409 assumptions_not_acknowledged until every needsAck assumption
 * is acknowledged. A repeated decision is a no-op.
 *
 * Enforced studies only (ASSISTANT_CONTROL_ENFORCE_STUDIES): approving also needs the AI second check to be clean. If it
 * is CONCERNS, UNAVAILABLE or never ran, the body must carry proceedReason (10 to 500 characters) or the answer is
 * 409 second_check_reason_required. The approval is then bound to the exact plan revision (selfApproved when the
 * approver wrote the plan); if that record cannot be written the plan is put back to draft and the answer is 503
 * control_unavailable.
 */

import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { json, problem } from "@/lib/json";
import { approvedStepsHash, planStaleness, requirementsHash, selectApprovedSteps, unacknowledgedAssumptions } from "@/lib/agent-plan";
import { branchHead } from "@/lib/agent-proposal-store";
import { auditThread, openThreadRoute, writableThreadOrResponse } from "@/lib/agent-thread-route";
import { appendTurn, getPlanInThread, planDto, transitionPlan, turnDto } from "@/lib/agent-thread-store";
import { AUDIT_ACTIONS, THREAD_ERROR_CODES } from "@/lib/agent-thread-types";
import { prisma } from "@/lib/prisma";
import { bindAssistantApproval, ensurePlanArtifact, invalidateApprovalBinding, loadControlDecorations, secondCheckGate } from "@/lib/assistant-artifacts";
import { effectiveControlMode } from "@/lib/runtime-config";

type Params = { params: Promise<{ studyId: string; projectId: string; tid: string; pid: string }> };

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  approvedStepIds: z.array(z.string().max(60)).max(50).optional(),
  ackAssumptions: z.array(z.string().max(60)).max(50).default([]),
  /** Enforced studies: why the person goes ahead when the second check is not clean. */
  proceedReason: z.string().max(2000).optional()
});

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId, tid, pid } = await params;
  const ctx = await openThreadRoute({ userId: authResult.userId, studyId, projectId, threadId: tid });
  if (!ctx.ok) return ctx.response;
  const refused = writableThreadOrResponse(ctx);
  if (refused) return refused;
  const thread = ctx.thread!;
  if (!ctx.access?.canDecidePlan) return problem(403, "Only the author of this thread can decide its plan.", THREAD_ERROR_CODES.readOnly);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid plan decision.");
  const body = parsed.data;

  const row = await getPlanInThread(thread.id, pid);
  if (!row) return problem(404, "Plan not found.", "not_found");
  const plan = planDto(row);
  const orgId = ctx.project.study.orgId;
  const auditBase = { request, userId: authResult.userId, orgId, studyId, projectId };

  const recordDecision = async (decision: "approve" | "reject", approvedStepIds?: string[]) => {
    const appended = await appendTurn({
      threadId: thread.id,
      role: "USER",
      kind: "PLAN_DECISION",
      payload: { planId: plan.id, decision, ...(approvedStepIds ? { approvedStepIds } : {}) },
      planId: plan.id,
      actorUserId: authResult.userId,
      clientTurnId: `plan-decision:${plan.id}:${decision}`
    });
    return { turn: appended.turn, fresh: !appended.duplicate };
  };

  if (body.decision === "reject") {
    if (plan.status === "REJECTED") {
      // A retry after a failed write: make sure the decision turn and audit entry exist, once.
      const recorded = await recordDecision("reject");
      if (recorded.fresh) await auditThread({ ...auditBase, action: AUDIT_ACTIONS.planReject, metadata: { threadId: thread.id, planId: plan.id, version: plan.version } });
      return json({ plan, noop: true });
    }
    if (!(await transitionPlan(plan.id, ["DRAFT", "APPROVED", "STALE"], "REJECTED", { decidedById: authResult.userId }))) {
      return problem(409, `This plan is already ${plan.status.toLowerCase()}.`, "plan_not_open");
    }
    const { turn } = await recordDecision("reject");
    await auditThread({ ...auditBase, action: AUDIT_ACTIONS.planReject, metadata: { threadId: thread.id, planId: plan.id, version: plan.version } });
    // Enforced studies only (the id is null otherwise): an approved plan that is rejected no longer stands behind its approval.
    await invalidateApprovalBinding({ studyId, approvalBindingId: row.approvalBindingId, reason: "The plan was rejected after it was approved.", source: { type: "AgentPlan", id: plan.id, hash: row.artifactRevisionId ?? plan.id } });
    return json({ plan: { ...plan, status: "REJECTED" }, turn: turnDto(turn) });
  }

  // approve
  if (plan.status === "APPROVED") {
    const approvedIds = plan.approvedStepIds ?? [];
    const recorded = await recordDecision("approve", approvedIds);
    if (recorded.fresh) {
      await auditThread({
        ...auditBase,
        action: AUDIT_ACTIONS.planApprove,
        metadata: { threadId: thread.id, planId: plan.id, version: plan.version, approvedStepCount: approvedIds.length, stepsHash: approvedStepsHash(plan, approvedIds), baseCommit: plan.baseCommit }
      });
    }
    return json({ plan, noop: true });
  }
  if (plan.status === "STALE") return problem(409, "The saved code or the study requirements changed after this plan was written. Plan again.", THREAD_ERROR_CODES.planStale);
  if (plan.status !== "DRAFT") return problem(409, `This plan is already ${plan.status.toLowerCase()}.`, "plan_not_open");

  let head: string | null;
  try {
    head = await branchHead(ctx.project);
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }
  const responses = await prisma.requirementResponse.findMany({ where: { studyId } });
  const staleness = planStaleness(plan, { head, requirementsHash: requirementsHash(responses) });
  if (staleness) {
    await transitionPlan(plan.id, ["DRAFT", "APPROVED"], "STALE");
    await auditThread({ ...auditBase, action: AUDIT_ACTIONS.planStale, metadata: { threadId: thread.id, planId: plan.id, version: plan.version, reason: staleness, baseCommit: plan.baseCommit, head } });
    return problem(409, "The saved code or the study requirements changed after this plan was written. Plan again.", THREAD_ERROR_CODES.planStale);
  }

  const missing = unacknowledgedAssumptions(plan, body.ackAssumptions);
  if (missing.length > 0) {
    return json({ error: { code: THREAD_ERROR_CODES.assumptionsNotAcknowledged, message: "Acknowledge every flagged assumption before approving.", details: missing } }, { status: 409 });
  }
  const selection = selectApprovedSteps(plan, body.approvedStepIds);
  if (!selection.ok) return problem(400, selection.message);

  const enforced = effectiveControlMode(studyId) === "enforce";
  let proceedReason: string | null = null;
  if (enforced) {
    const gate = secondCheckGate(row.verificationStatus, body.proceedReason);
    if (!gate.ok) {
      const view = (await loadControlDecorations(studyId, [row]).catch(() => new Map())).get(row.id);
      return json({ error: { code: gate.code, message: gate.message, details: { verificationStatus: view?.verificationStatus ?? row.verificationStatus ?? null, findings: view?.findings ?? [] } } }, { status: 409 });
    }
    proceedReason = gate.reason;
  }

  const won = await transitionPlan(plan.id, ["DRAFT"], "APPROVED", { decidedById: authResult.userId, approvedStepIds: selection.stepIds });
  if (!won) {
    // Lost a race: report the plan as it is now. An approve that landed first makes this one a no-op.
    const current = await getPlanInThread(thread.id, plan.id);
    if (current?.status === "APPROVED") return json({ plan: planDto(current), noop: true });
    return problem(409, "This plan was already decided.", "plan_not_open");
  }
  let approval: { bindingId: string; selfApproved: boolean } | null = null;
  if (enforced) {
    try {
      const artifact = await ensurePlanArtifact(row, { studyId, userId: authResult.userId });
      approval = await bindAssistantApproval({
        kind: "plan",
        studyId,
        rowId: plan.id,
        artifact,
        approverId: authResult.userId,
        requesterId: thread.createdById,
        verificationStatus: row.verificationStatus,
        proceedReason,
        details: { threadId: thread.id, planVersion: plan.version, approvedStepCount: selection.stepIds.length },
        scope: { kind: "steps", items: selection.stepIds, hash: approvedStepsHash(plan, selection.stepIds) }
      });
    } catch (error) {
      // Nothing may count as approved without its record: put the plan back so the person can try again.
      console.error("agent plan: could not record the approval", error instanceof Error ? error.name : "unknown error");
      await prisma.agentPlan.updateMany({ where: { id: plan.id, status: "APPROVED" }, data: { status: "DRAFT", decidedById: null, decidedAt: null, approvedStepIds: Prisma.DbNull } }).catch(() => undefined);
      return problem(503, "The approval could not be recorded, so nothing was approved. Try again.", "control_unavailable");
    }
  }
  const { turn } = await recordDecision("approve", selection.stepIds);
  await auditThread({
    ...auditBase,
    action: AUDIT_ACTIONS.planApprove,
    metadata: { threadId: thread.id, planId: plan.id, version: plan.version, approvedStepCount: selection.stepIds.length, stepsHash: approvedStepsHash(plan, selection.stepIds), baseCommit: plan.baseCommit, ...(approval ? { approvalBindingId: approval.bindingId, selfApproved: approval.selfApproved, secondCheck: row.verificationStatus ?? "NOT_RUN" } : {}) }
  });
  return json({
    plan: { ...plan, status: "APPROVED", approvedStepIds: selection.stepIds, decidedById: authResult.userId },
    turn: turnDto(turn),
    ...(approval ? { approval: { bindingId: approval.bindingId, selfApproved: approval.selfApproved } } : {})
  });
}
