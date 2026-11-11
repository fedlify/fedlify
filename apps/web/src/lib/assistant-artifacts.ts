/**
 * Enforced control plane for assistant plans and proposals: artifact revisions, rule-based verification runs, the
 * human gate (reason when the AI second check is not clean) and approval bindings.
 *
 * Why this file exists instead of calling control-plane-store.ts directly:
 *  - createArtifactRevision needs an EVIDENCE_ASSEMBLED work item, request-context headers (idempotency key, expected
 *    version) and writes a mutation receipt. A chat plan is produced inside one assistant turn; there is no such chain.
 *  - recordVerification walks the work-item state chain (WORKER_COMPLETED -> DETERMINISTIC_VERIFIED -> SEMANTIC_VERIFIED)
 *    and evaluates platform rules over stored S3 payloads. The assistant's rule checks already ran in code; the
 *    second check is advisory and must never move a state or block.
 *  - bindApproval REFUSES when the approver is the requester and needs a SEMANTIC_VERIFIED work item. The product rule
 *    here is the opposite: a person may accept their own change, and it is recorded as self-approved.
 * So these are small internal variants that write the same tables with the same invariants that still apply
 * (immutable revision with a content hash, verification run per exact revision, binding to the exact revision hash,
 * provenance edges, dependency invalidation) and none of the probe protocol.
 *
 * Nothing here ever throws into a route unless the function says so; callers decide what a failure means.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sha256 } from "@/lib/crypto";
import { CONTROL_POLICY_VERSION, contentHash, redactSecrets } from "@/lib/control-plane";
import { isPlannablePath } from "@/lib/agent-plan";
import { readStoredFiles } from "@/lib/agent-proposal-store";
import { isSensitiveFilePath } from "@/lib/repo-checks";
import { inspectAssistantIntake } from "@/lib/control-intake";
import type { PlanAssumption, PlanStep } from "@/lib/agent-thread-types";

export const PLAN_ARTIFACT_TYPE = "assistant_plan";
export const PROPOSAL_ARTIFACT_TYPE = "assistant_proposal";
export const PROCEED_REASON_MIN = 10;
export const PROCEED_REASON_MAX = 500;
export const FINDING_LIMITS = { count: 8, text: 400 } as const;

export type SecondCheckStatus = "CHECKING" | "PASSED" | "CONCERNS" | "UNAVAILABLE";
export type FindingKind = "contradiction" | "beyond_request" | "other";
export type SecondCheckFinding = { kind: FindingKind; text: string };

function warn(label: string, error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  console.warn(`assistant-artifacts: ${label} failed (${error instanceof Error ? error.name : "unknown"}${code ? ` ${code}` : ""})`);
}

// ---------- content hashes ----------

type PlanContent = { steps: unknown; assumptions: unknown; baseCommit: string; requirementsHash: string };

/** What a plan artifact is made of: steps + assumptions + base commit + requirements hash. Nothing else, so it is stable. */
export function planContentDigest(plan: PlanContent): string {
  return contentHash({ steps: plan.steps, assumptions: plan.assumptions, baseCommit: plan.baseCommit, requirementsHash: plan.requirementsHash });
}

/** What a proposal artifact is made of: file paths + actions + content hashes + base commit. */
export function proposalContentDigest(proposal: { files: unknown; baseCommit: string | null }): string {
  const files = readStoredFiles(proposal.files as never)
    .map((file) => ({ path: file.path, action: file.action, contentSha: file.content === null ? null : sha256(file.content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return contentHash({ files, baseCommit: proposal.baseCommit });
}

/**
 * The stored revision hash also covers the subject id: the table is unique on (study, hash), and an approval must bind
 * to exactly this plan or proposal, never to a different row that happens to have identical content.
 */
export function revisionHash(type: string, subjectId: string, digest: string): string {
  return contentHash({ type, subjectId, digest });
}

// ---------- artifact revisions ----------

type Ctx = { studyId: string; userId: string };
export type ArtifactRef = { id: string; contentHash: string; sourceCommit: string | null };

export async function createRevision(input: Ctx & { workItemId: string | null; type: string; subjectId: string; digest: string; sourceCommit: string | null; metadata: Record<string, unknown> }): Promise<ArtifactRef> {
  const hash = revisionHash(input.type, input.subjectId, input.digest);
  const found = await prisma.artifactRevision.findFirst({ where: { studyId: input.studyId, contentHash: hash } });
  if (found) return { id: found.id, contentHash: found.contentHash, sourceCommit: found.sourceCommit };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await prisma.artifactRevision.aggregate({ where: { studyId: input.studyId, artifactType: input.type }, _max: { revision: true } });
    try {
      const created = await prisma.artifactRevision.create({
        data: {
          studyId: input.studyId,
          workItemId: input.workItemId,
          artifactType: input.type,
          revision: (latest._max.revision ?? 0) + 1,
          contentHash: hash,
          storageLocator: `db://${input.type}/${input.subjectId}`,
          sourceCommit: input.sourceCommit,
          policyVersion: CONTROL_POLICY_VERSION,
          metadata: { subjectId: input.subjectId, contentDigest: input.digest, ...input.metadata } as Prisma.InputJsonValue,
          createdById: input.userId
        }
      });
      return { id: created.id, contentHash: created.contentHash, sourceCommit: created.sourceCommit };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const again = await prisma.artifactRevision.findFirst({ where: { studyId: input.studyId, contentHash: hash } });
      if (again) return { id: again.id, contentHash: again.contentHash, sourceCommit: again.sourceCommit };
    }
  }
  throw new Error("artifact revision number kept colliding");
}

export type RuleCheck = { id: string; ok: boolean; note?: string };

async function createRuleRun(input: Ctx & { workItemId: string | null; artifact: ArtifactRef; verifier: string; checks: RuleCheck[] }) {
  const passed = input.checks.every((check) => check.ok);
  const findings = input.checks.filter((check) => !check.ok).map((check) => ({ code: check.id, note: check.note ?? null }));
  return prisma.verificationRun.create({
    data: {
      studyId: input.studyId,
      workItemId: input.workItemId,
      artifactRevisionId: input.artifact.id,
      kind: "DETERMINISTIC",
      status: passed ? "PASSED" : "FAILED",
      verifier: input.verifier,
      checks: input.checks as unknown as Prisma.InputJsonValue,
      findings: findings as unknown as Prisma.InputJsonValue,
      inputHash: input.artifact.contentHash,
      outputHash: contentHash({ passed, checks: input.checks }),
      startedAt: new Date(),
      completedAt: new Date()
    }
  });
}

export type PlanRow = {
  id: string;
  threadId: string;
  steps: unknown;
  assumptions: unknown;
  baseCommit: string;
  requirementsHash: string;
  workItemId?: string | null;
  artifactRevisionId?: string | null;
};

/** Rule checks over a plan: the shape the planner promised, and only paths the assistant may ever write. */
export function planRuleChecks(plan: Pick<PlanRow, "steps">): RuleCheck[] {
  const steps = Array.isArray(plan.steps) ? (plan.steps as PlanStep[]) : [];
  const shaped = steps.length > 0 && steps.every((step) => step && typeof step.id === "string" && typeof step.title === "string" && Array.isArray(step.paths) && ["create", "update", "delete"].includes(step.action));
  const paths = steps.flatMap((step) => (Array.isArray(step?.paths) ? step.paths : []));
  const badPaths = paths.filter((path) => typeof path !== "string" || !isPlannablePath(path));
  const sensitive = paths.filter((path) => typeof path === "string" && isSensitiveFilePath(path));
  return [
    { id: "plan_schema", ok: shaped, ...(shaped ? {} : { note: "The plan has no steps or a step is malformed." }) },
    { id: "allowed_paths", ok: badPaths.length === 0, ...(badPaths.length ? { note: `${badPaths.length} path(s) the assistant may not write` } : {}) },
    { id: "no_sensitive_paths", ok: sensitive.length === 0, ...(sensitive.length ? { note: `${sensitive.length} sensitive path(s)` } : {}) }
  ];
}

/**
 * Make sure a plan has its artifact revision (and, the first time, its rule-based verification run) and store the id on the row.
 * Idempotent: a plan that already has a revision returns it.
 */
export async function ensurePlanArtifact(plan: PlanRow, ctx: Ctx & { workItemId?: string | null }): Promise<ArtifactRef> {
  if (plan.artifactRevisionId) {
    const existing = await prisma.artifactRevision.findFirst({ where: { id: plan.artifactRevisionId, studyId: ctx.studyId } });
    if (existing) return { id: existing.id, contentHash: existing.contentHash, sourceCommit: existing.sourceCommit };
  }
  const workItemId = ctx.workItemId ?? plan.workItemId ?? null;
  const artifact = await createRevision({
    ...ctx,
    workItemId,
    type: PLAN_ARTIFACT_TYPE,
    subjectId: plan.id,
    digest: planContentDigest(plan),
    sourceCommit: plan.baseCommit,
    metadata: { threadId: plan.threadId, requirementsHash: plan.requirementsHash }
  });
  const hasRun = await prisma.verificationRun.findFirst({ where: { studyId: ctx.studyId, artifactRevisionId: artifact.id, kind: "DETERMINISTIC" }, select: { id: true } });
  if (!hasRun) await createRuleRun({ ...ctx, workItemId, artifact, verifier: "platform:assistant-plan:v1", checks: planRuleChecks(plan) });
  await prisma.agentPlan.updateMany({ where: { id: plan.id }, data: { artifactRevisionId: artifact.id, ...(workItemId && !plan.workItemId ? { workItemId } : {}) } });
  return artifact;
}

export type ProposalRow = {
  id: string;
  files: unknown;
  baseCommit: string | null;
  planId?: string | null;
  threadId?: string | null;
  workItemId?: string | null;
  artifactRevisionId?: string | null;
};

/**
 * The same for a proposal. `ran` says which rule checks already ran when the proposal was made: validateProposalFiles
 * (which includes scanAddedRisks) passed, because a proposal that fails it is never stored, and the paths outside the plan.
 * `outsidePlanPaths` is null when it was not evaluated (a late call without the plan in hand).
 */
export async function ensureProposalArtifact(proposal: ProposalRow, ctx: Ctx & { workItemId?: string | null; outsidePlanPaths?: string[] | null }): Promise<ArtifactRef> {
  if (proposal.artifactRevisionId) {
    const existing = await prisma.artifactRevision.findFirst({ where: { id: proposal.artifactRevisionId, studyId: ctx.studyId } });
    if (existing) return { id: existing.id, contentHash: existing.contentHash, sourceCommit: existing.sourceCommit };
  }
  const workItemId = ctx.workItemId ?? proposal.workItemId ?? null;
  const artifact = await createRevision({
    ...ctx,
    workItemId,
    type: PROPOSAL_ARTIFACT_TYPE,
    subjectId: proposal.id,
    digest: proposalContentDigest(proposal),
    sourceCommit: proposal.baseCommit,
    metadata: { planId: proposal.planId ?? null, threadId: proposal.threadId ?? null, fileCount: readStoredFiles(proposal.files as never).length }
  });
  const hasRun = await prisma.verificationRun.findFirst({ where: { studyId: ctx.studyId, artifactRevisionId: artifact.id, kind: "DETERMINISTIC" }, select: { id: true } });
  if (!hasRun) {
    const outside = ctx.outsidePlanPaths;
    const checks: RuleCheck[] = [
      { id: "validate_proposal_files", ok: true, note: "Repository rules and allowed paths passed when the proposal was made." },
      { id: "scan_added_risks", ok: true, note: "Added lines were scanned for risky content when the proposal was made." },
      outside === undefined || outside === null
        ? { id: "inside_plan", ok: true, note: "Not evaluated." }
        : { id: "inside_plan", ok: outside.length === 0, ...(outside.length ? { note: `${outside.length} file(s) outside the approved plan` } : {}) }
    ];
    await createRuleRun({ ...ctx, workItemId, artifact, verifier: "platform:assistant-proposal:v1", checks });
  }
  await prisma.agentProposal.updateMany({ where: { id: proposal.id }, data: { artifactRevisionId: artifact.id, ...(workItemId && !proposal.workItemId ? { workItemId } : {}) } });
  return artifact;
}

/** Run right after a plan or proposal is stored. Never throws: a missing record is created again when it is needed. */
export async function recordPlanControl(plan: PlanRow, ctx: Ctx & { workItemId: string | null }): Promise<void> {
  try {
    await ensurePlanArtifact(plan, ctx);
  } catch (error) {
    warn("plan artifact", error);
  }
}

export async function recordProposalControl(proposal: ProposalRow, ctx: Ctx & { workItemId: string | null; outsidePlanPaths: string[] | null }): Promise<void> {
  try {
    await ensureProposalArtifact(proposal, ctx);
  } catch (error) {
    warn("proposal artifact", error);
  }
}

// ---------- the AI second check: records ----------

export function capFindings(input: Array<{ kind: FindingKind; text: string }>): SecondCheckFinding[] {
  return input
    .slice(0, FINDING_LIMITS.count)
    .map((finding) => ({
      kind: finding.kind,
      text: redactSecrets(String(finding.text ?? "")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, FINDING_LIMITS.text)
    }))
    .filter((finding) => finding.text.length > 0);
}

export function readFindings(value: unknown): SecondCheckFinding[] {
  if (!Array.isArray(value)) return [];
  const out: SecondCheckFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string") continue;
    const kind: FindingKind = record.kind === "contradiction" || record.kind === "beyond_request" ? record.kind : "other";
    out.push({ kind, text: record.text.slice(0, FINDING_LIMITS.text) });
  }
  return out.slice(0, FINDING_LIMITS.count);
}

export type ControlDecoration = {
  verificationStatus: SecondCheckStatus | null;
  findings: SecondCheckFinding[];
  /** The rule-based check: PASSED or FAILED, null when not recorded. */
  ruleCheck: "PASSED" | "FAILED" | null;
  approval: { approvedById: string | null; approvedByName: string | null; selfApproved: boolean; valid: boolean; approvedAt: string | null } | null;
};

type DecorationSubject = { id: string; artifactRevisionId: string | null; verificationStatus: string | null; approvalBindingId: string | null };

/** What the screens need to show the second check and the approval, read once for a whole thread. */
export async function loadControlDecorations(studyId: string, subjects: DecorationSubject[]): Promise<Map<string, ControlDecoration>> {
  const result = new Map<string, ControlDecoration>();
  if (subjects.length === 0) return result;
  const artifactIds = [...new Set(subjects.map((subject) => subject.artifactRevisionId).filter((id): id is string => Boolean(id)))];
  const bindingIds = [...new Set(subjects.map((subject) => subject.approvalBindingId).filter((id): id is string => Boolean(id)))];
  const [runs, bindings] = await Promise.all([
    artifactIds.length ? prisma.verificationRun.findMany({ where: { studyId, artifactRevisionId: { in: artifactIds } }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
    bindingIds.length ? prisma.approvalBinding.findMany({ where: { id: { in: bindingIds }, studyId } }) : Promise.resolve([])
  ]);
  const approverIds = [...new Set(bindings.map((binding) => binding.approvedById).filter((id): id is string => Boolean(id)))];
  const users = approverIds.length ? await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } }) : [];
  for (const subject of subjects) {
    const own = runs.filter((run) => run.artifactRevisionId === subject.artifactRevisionId);
    const rule = own.find((run) => run.kind === "DETERMINISTIC");
    const semantic = own.find((run) => run.kind === "SEMANTIC" && run.status !== "RUNNING");
    const binding = bindings.find((item) => item.id === subject.approvalBindingId);
    const user = binding?.approvedById ? users.find((item) => item.id === binding.approvedById) : undefined;
    const status = subject.verificationStatus as SecondCheckStatus | null;
    result.set(subject.id, {
      verificationStatus: status ?? null,
      findings: status === "CONCERNS" ? readFindings(semantic?.findings) : [],
      ruleCheck: rule ? (rule.status === "PASSED" ? "PASSED" : "FAILED") : null,
      approval: binding
        ? { approvedById: binding.approvedById, approvedByName: user?.name ?? null, selfApproved: binding.selfApproved, valid: binding.status === "APPROVED", approvedAt: binding.approvedAt ? binding.approvedAt.toISOString() : null }
        : null
    });
  }
  return result;
}

// ---------- the human gate ----------

export type SecondCheckGate = { ok: true; reason: string | null } | { ok: false; code: "second_check_reason_required"; message: string; status: string };

const GATE_MESSAGES: Record<string, string> = {
  CONCERNS: "The second check found things to look at. Write a short reason for going ahead anyway.",
  UNAVAILABLE: "The second check could not run. Write a short reason for going ahead without it.",
  CHECKING: "The second check is still running. Wait for it to finish, or write a short reason for going ahead now.",
  NONE: "The second check has not run. Wait for it to finish, or write a short reason for going ahead without it."
};

/** Capped, secrets removed: the reason is the person's own words and is kept in the decision record. */
export function cleanReason(value: string | undefined | null): string | null {
  const text = redactSecrets(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, PROCEED_REASON_MAX);
  return text.length > 0 ? text : null;
}

const REASON_CONTENT_MESSAGE = "Please describe your reason in words, without data, keys or passwords.";

/** A clean second check lets the person through. Anything else (concerns, could not check, not run) needs a written reason. */
export function secondCheckGate(verificationStatus: string | null | undefined, proceedReason: string | undefined | null): SecondCheckGate {
  const reason = cleanReason(proceedReason);
  const status = verificationStatus ?? "NONE";
  // The reason is kept in the ledger as plain text, so it gets the same content check as a chat message (on the raw text, before redaction).
  if (proceedReason && inspectAssistantIntake(String(proceedReason)).verdict === "quarantine") {
    return { ok: false, code: "second_check_reason_required", status, message: REASON_CONTENT_MESSAGE };
  }
  if (verificationStatus === "PASSED") return { ok: true, reason };
  if (reason && reason.length >= PROCEED_REASON_MIN) return { ok: true, reason };
  return {
    ok: false,
    code: "second_check_reason_required",
    status,
    message: reason ? `${GATE_MESSAGES[status] ?? GATE_MESSAGES.NONE} Use at least ${PROCEED_REASON_MIN} characters.` : GATE_MESSAGES[status] ?? GATE_MESSAGES.NONE
  };
}

// ---------- approval bindings ----------

export type BindInput = {
  kind: "plan" | "proposal";
  studyId: string;
  rowId: string;
  artifact: ArtifactRef;
  approverId: string;
  requesterId: string;
  verificationStatus: string | null;
  proceedReason: string | null;
  /** Ids and counts only. */
  details?: Record<string, unknown>;
  /** What exactly was approved when it is part of the revision (some steps, some files): the ids and a hash of them. */
  scope?: { kind: "steps" | "paths"; items: string[]; hash: string } | null;
  /** Proposal accepts: the commit that was written, and the artifact of the plan it came from. */
  commitSha?: string | null;
  planArtifact?: { id: string; contentHash: string } | null;
};

/**
 * Record the human decision: a DecisionRecord (reason hash and length in the decision, the person's own words in the
 * rationale), an ApprovalBinding to the exact revision (selfApproved when the approver is the requester), provenance
 * edges, and the ids on the row. One transaction. Throws on failure; the caller decides whether that undoes the approval.
 */
export async function bindAssistantApproval(input: BindInput): Promise<{ bindingId: string; decisionRecordId: string; selfApproved: boolean }> {
  const selfApproved = input.approverId === input.requesterId;
  const at = new Date();
  const reasonInfo = input.proceedReason ? { sha: contentHash(input.proceedReason), chars: input.proceedReason.length } : null;
  const decision = {
    policyVersion: CONTROL_POLICY_VERSION,
    kind: input.kind === "plan" ? "assistant_plan_approved" : "assistant_change_accepted",
    subjectId: input.rowId,
    artifactRevisionId: input.artifact.id,
    artifactHash: input.artifact.contentHash,
    verificationStatus: input.verificationStatus ?? "NOT_RUN",
    proceedReason: reasonInfo,
    selfApproved,
    ...(input.scope ? { scope: input.scope } : {}),
    approverId: input.approverId,
    requesterId: input.requesterId,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.details ?? {})
  };
  return prisma.$transaction(async (tx) => {
    const decisionRow = await tx.decisionRecord.create({
      data: {
        studyId: input.studyId,
        decisionType: input.kind === "plan" ? "ASSISTANT_PLAN_APPROVED" : "ASSISTANT_CHANGE_ACCEPTED",
        decision: decision as unknown as Prisma.InputJsonValue,
        rationale: input.proceedReason ?? (input.verificationStatus === "PASSED" ? "Approved after the second check passed." : "Approved."),
        evidenceIds: [],
        artifactIds: [input.artifact.id],
        decisionHash: contentHash({ studyId: input.studyId, kind: input.kind, subjectId: input.rowId, approverId: input.approverId, at: at.toISOString() }),
        decidedById: input.approverId
      }
    });
    const binding = await tx.approvalBinding.create({
      data: {
        studyId: input.studyId,
        artifactRevisionId: input.artifact.id,
        artifactHash: input.artifact.contentHash,
        sourceCommit: input.artifact.sourceCommit,
        policyVersion: CONTROL_POLICY_VERSION,
        evidenceHash: contentHash({ decisionId: decisionRow.id, verificationStatus: input.verificationStatus ?? "NOT_RUN", reason: reasonInfo, scope: input.scope?.hash ?? null }),
        status: "APPROVED",
        approvedById: input.approverId,
        approvedAt: at,
        selfApproved
      }
    });
    if (input.kind === "proposal") {
      if (input.planArtifact) {
        await tx.provenanceEdge.upsert({
          where: { studyId_fromId_toId_relation: { studyId: input.studyId, fromId: input.planArtifact.id, toId: input.artifact.id, relation: "LED_TO" } },
          create: { studyId: input.studyId, fromType: "ArtifactRevision", fromId: input.planArtifact.id, fromHash: input.planArtifact.contentHash, toType: "ArtifactRevision", toId: input.artifact.id, toHash: input.artifact.contentHash, relation: "LED_TO" },
          update: {}
        });
      }
      if (input.commitSha) {
        await tx.provenanceEdge.upsert({
          where: { studyId_fromId_toId_relation: { studyId: input.studyId, fromId: input.artifact.id, toId: input.commitSha, relation: "COMMITTED_AS" } },
          create: { studyId: input.studyId, fromType: "ArtifactRevision", fromId: input.artifact.id, fromHash: input.artifact.contentHash, toType: "Commit", toId: input.commitSha, toHash: input.commitSha, relation: "COMMITTED_AS" },
          update: {}
        });
      }
      await tx.agentProposal.updateMany({ where: { id: input.rowId }, data: { approvalBindingId: binding.id, decisionRecordId: decisionRow.id } });
    } else {
      await tx.agentPlan.updateMany({ where: { id: input.rowId }, data: { approvalBindingId: binding.id } });
    }
    return { bindingId: binding.id, decisionRecordId: decisionRow.id, selfApproved };
  });
}

/**
 * The thing the approval was about changed (the plan went stale, the saved head moved, the plan was rejected after
 * approval). Marks the binding invalid and opens a DependencyInvalidation. Best effort, returns whether it acted.
 */
export async function invalidateApprovalBinding(input: { studyId: string; approvalBindingId: string | null | undefined; reason: string; source: { type: string; id: string; hash: string } }): Promise<boolean> {
  if (!input.approvalBindingId) return false;
  try {
    return await prisma.$transaction(async (tx) => {
      const moved = await tx.approvalBinding.updateMany({
        where: { id: input.approvalBindingId!, studyId: input.studyId, status: "APPROVED" },
        data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidationReason: input.reason }
      });
      if (moved.count === 0) return false;
      await tx.dependencyInvalidation.create({
        data: { studyId: input.studyId, sourceType: input.source.type, sourceId: input.source.id, sourceHash: input.source.hash, targetType: "ApprovalBinding", targetId: input.approvalBindingId!, reason: input.reason }
      });
      return true;
    });
  } catch (error) {
    warn("invalidate binding", error);
    return false;
  }
}

/**
 * The saved code moved (an accepted change or a manual save). Approved plans of this project that were written against an
 * older commit are no longer what the approval was about: they become STALE and their binding is marked invalid, so a
 * card does not keep saying "Approved by ..." for a plan that can no longer be used. Best effort; never throws.
 */
export async function invalidateStalePlanApprovals(input: { studyId: string; projectId: string; head: string }): Promise<number> {
  try {
    const plans = await prisma.agentPlan.findMany({
      where: { status: "APPROVED", approvalBindingId: { not: null }, baseCommit: { not: input.head }, thread: { projectId: input.projectId } },
      select: { id: true, approvalBindingId: true, artifactRevisionId: true }
    });
    let count = 0;
    for (const plan of plans) {
      await prisma.agentPlan.updateMany({ where: { id: plan.id, status: "APPROVED" }, data: { status: "STALE" } });
      if (await invalidateApprovalBinding({ studyId: input.studyId, approvalBindingId: plan.approvalBindingId, reason: "The saved code changed after the plan was approved.", source: { type: "Commit", id: input.head, hash: input.head } })) count += 1;
    }
    return count;
  } catch (error) {
    warn("stale plan approvals", error);
    return 0;
  }
}
