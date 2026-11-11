/**
 * The AI second check for plans and proposals (advisory). Client-triggered through the verify routes.
 *
 * It never blocks: it records what a second model thinks and stores one of CHECKING | PASSED | CONCERNS | UNAVAILABLE on
 * the row. The human gates (plan decision, accept) read that status and ask for a written reason when it is not PASSED.
 * Model output is data: findings are capped, secrets removed, control characters stripped, and shown as plain text.
 */

import { prisma } from "@/lib/prisma";
import { contentHash, signControlPayload } from "@/lib/control-plane";
import { buildWorkItemSignedPayload } from "@/lib/control-plane-store";
import { contractSpec, ensureContract } from "@/lib/assistant-control";
import { verifyThroughOrchestrator } from "@/lib/orchestrator-client";
import { capFindings, ensurePlanArtifact, ensureProposalArtifact, loadControlDecorations, type PlanRow, type ProposalRow, type SecondCheckFinding, type SecondCheckStatus } from "@/lib/assistant-artifacts";
import { readStoredFiles } from "@/lib/agent-proposal-store";
import type { PlanStep } from "@/lib/agent-thread-types";
import type { Prisma } from "@prisma/client";

export const SECOND_CHECK_TIMEOUT_MS = 45_000;
/** A CHECKING mark older than this is a call that died; a new call may take over. */
export const CHECKING_STALE_MS = 90_000;
const FILE_CONTENT_CAP = 6000;
const TOTAL_CONTENT_CAP = 60_000;

export type SecondCheckResult = {
  status: SecondCheckStatus;
  findings: SecondCheckFinding[];
  ruleCheck: "PASSED" | "FAILED" | null;
  /** True when the stored result was returned and no check ran. */
  cached: boolean;
};

type Subject =
  | { kind: "plan"; row: PlanRow & { verificationStatus: string | null; summary: string }; request: string }
  | { kind: "proposal"; row: ProposalRow & { verificationStatus: string | null; prompt: string; title: string | null; rationale: string | null }; plan: { summary: string; steps: unknown } | null };

/** Both tables share the two columns used here, so one update helper serves both. */
function updateStatus(kind: "plan" | "proposal", id: string, expected: string | null | undefined, status: string) {
  const args = { where: { id, ...(expected === undefined ? {} : { verificationStatus: expected }) }, data: { verificationStatus: status } };
  return kind === "plan" ? prisma.agentPlan.updateMany(args) : prisma.agentProposal.updateMany(args);
}

/** Claims the checker judges: one plain sentence per step or per file, from the stored rows. */
function buildProposalForChecker(subject: Subject) {
  if (subject.kind === "plan") {
    const steps = Array.isArray(subject.row.steps) ? (subject.row.steps as PlanStep[]) : [];
    const claims = steps.slice(0, 50).map((step) => ({ statement: `${step.action} ${step.paths.join(", ")}: ${step.title}. ${step.rationale}`.slice(0, 1500), evidenceIds: [REQUEST_EVIDENCE] }));
    return {
      disposition: "PROPOSE" as const,
      summary: subject.row.summary.slice(0, 4000),
      claims,
      artifact: { kind: "plan", steps: steps.map((step) => ({ title: step.title, paths: step.paths, action: step.action, risk: step.risk })), assumptions: subject.row.assumptions },
      unresolved: [] as string[],
      requestedActions: [] as string[]
    };
  }
  const files = readStoredFiles(subject.row.files as Prisma.JsonValue);
  let budget = TOTAL_CONTENT_CAP;
  const shown = files.slice(0, 40).map((file) => {
    const content = file.content === null ? null : file.content.slice(0, Math.min(FILE_CONTENT_CAP, Math.max(0, budget)));
    budget -= content?.length ?? 0;
    return { path: file.path, action: file.action, added: file.added, removed: file.removed, content };
  });
  return {
    disposition: "PROPOSE" as const,
    summary: `${subject.row.title ?? "Proposed change"}. ${subject.row.rationale ?? ""}`.slice(0, 4000),
    claims: files.slice(0, 100).map((file) => ({ statement: `${file.action} ${file.path} (+${file.added} -${file.removed})`, evidenceIds: [fileEvidenceId(file.path), ...(subject.plan ? [PLAN_EVIDENCE] : [])] })),
    artifact: { kind: "code_change", files: shown, approvedPlan: subject.plan },
    unresolved: [] as string[],
    requestedActions: [] as string[]
  };
}

const REQUEST_EVIDENCE = "request";
const PLAN_EVIDENCE = "approved-plan";
const fileEvidenceId = (path: string) => `file:${path}`;
const CHECKER_TASK =
  "Judge only two things: does the proposal contradict the request, and does it go beyond what the request asks. " +
  "The evidence items hold the request, the approved plan if there is one, and the full content of each changed file. " +
  "A plan has no file contents yet; that is expected and is not missing evidence.";

/**
 * What the checker may rely on: the person's request, the approved plan, and each changed file. Without these the
 * checker can only answer "insufficient evidence", whatever the proposal says.
 */
function buildEvidenceForChecker(subject: Subject): Array<{ id: string; contentHash: string; content: unknown }> {
  const item = (id: string, content: unknown) => ({ id, contentHash: contentHash(content), content });
  const evidence = [item(REQUEST_EVIDENCE, requestFor(subject))];
  if (subject.kind === "plan") return evidence;
  if (subject.plan) evidence.push(item(PLAN_EVIDENCE, subject.plan));
  let budget = TOTAL_CONTENT_CAP;
  for (const file of readStoredFiles(subject.row.files as Prisma.JsonValue).slice(0, 40)) {
    const content = file.content === null ? null : file.content.slice(0, Math.min(FILE_CONTENT_CAP, Math.max(0, budget)));
    budget -= content?.length ?? 0;
    evidence.push(item(fileEvidenceId(file.path), { path: file.path, action: file.action, added: file.added, removed: file.removed, content }));
  }
  return evidence;
}

/** What the person asked for: the confirmed specification the checker compares against. */
function requestFor(subject: Subject): string {
  return (subject.kind === "plan" ? subject.request : subject.row.prompt).slice(0, 8000);
}

/**
 * Maps the checker's answer to the status and findings stored on the row. Findings are advice; none of this blocks.
 * Only a contradiction or going beyond the request is a concern that asks the person for a reason. Anything else the
 * checker raises (for example "not enough evidence to judge") is kept as a note on a passed check.
 */
export function interpretVerification(output: { disposition: string; findings: Array<{ severity: string; message: string }> }): { status: "PASSED" | "CONCERNS"; findings: SecondCheckFinding[] } {
  const concerning = output.disposition === "CONTRADICTED" || output.disposition === "SCOPE_DRIFT";
  const kind: SecondCheckFinding["kind"] = output.disposition === "CONTRADICTED" ? "contradiction" : output.disposition === "SCOPE_DRIFT" ? "beyond_request" : "other";
  const findings = capFindings(output.findings.filter((finding) => finding.severity !== "INFO").map((finding) => ({ kind, text: finding.message })));
  if (!concerning) return { status: "PASSED", findings };
  if (findings.length === 0) {
    findings.push({
      kind,
      text: output.disposition === "CONTRADICTED" ? "The check reported a contradiction with the request but gave no detail." : "The check reported that this goes beyond the request but gave no detail."
    });
  }
  return { status: "CONCERNS", findings };
}

async function decorated(studyId: string, kind: "plan" | "proposal", id: string): Promise<SecondCheckResult | null> {
  const row = await (kind === "plan"
    ? prisma.agentPlan.findUnique({ where: { id }, select: { id: true, artifactRevisionId: true, verificationStatus: true, approvalBindingId: true } })
    : prisma.agentProposal.findUnique({ where: { id }, select: { id: true, artifactRevisionId: true, verificationStatus: true, approvalBindingId: true } }));
  if (!row) return null;
  const view = (await loadControlDecorations(studyId, [row])).get(row.id);
  return { status: (view?.verificationStatus ?? "UNAVAILABLE") as SecondCheckStatus, findings: view?.findings ?? [], ruleCheck: view?.ruleCheck ?? null, cached: true };
}

/**
 * Idempotent: a stored PASSED, CONCERNS or UNAVAILABLE comes back unchanged unless `retry` is set; a fresh CHECKING mark
 * comes back as CHECKING. Otherwise the check runs once (the row is claimed first, so two calls never both run).
 */
export async function runSecondCheck(input: { studyId: string; userId: string; subject: Subject; retry: boolean; timeoutMs?: number }): Promise<SecondCheckResult> {
  const { studyId, userId, subject } = input;
  const row = subject.row;
  const current = row.verificationStatus;

  if (current === "CHECKING") {
    const running = await prisma.verificationRun.findFirst({ where: { studyId, artifactRevisionId: row.artifactRevisionId ?? "", kind: "SEMANTIC", status: "RUNNING" }, orderBy: { createdAt: "desc" } });
    if (running && Date.now() - running.createdAt.getTime() < CHECKING_STALE_MS) {
      const view = await decorated(studyId, subject.kind, row.id);
      return { status: "CHECKING", findings: [], ruleCheck: view?.ruleCheck ?? null, cached: true };
    }
  } else if (current && !input.retry) {
    const stored = await decorated(studyId, subject.kind, row.id);
    if (stored) return stored;
  }

  const claimed = await updateStatus(subject.kind, row.id, current, "CHECKING");
  if (claimed.count === 0) {
    const stored = await decorated(studyId, subject.kind, row.id);
    if (stored) return { ...stored, status: stored.status };
    return { status: "CHECKING", findings: [], ruleCheck: null, cached: true };
  }

  const finish = async (status: SecondCheckStatus) => {
    await updateStatus(subject.kind, row.id, undefined, status);
  };

  let artifact: Awaited<ReturnType<typeof ensurePlanArtifact>>;
  let runId: string | null = null;
  try {
    artifact = subject.kind === "plan" ? await ensurePlanArtifact(subject.row, { studyId, userId }) : await ensureProposalArtifact(subject.row, { studyId, userId });
  } catch {
    await finish("UNAVAILABLE").catch(() => undefined);
    return { status: "UNAVAILABLE", findings: [], ruleCheck: null, cached: false };
  }

  const workItemId = row.workItemId ?? null;
  let outcome: { status: "PASSED" | "CONCERNS" | "UNAVAILABLE"; findings: SecondCheckFinding[]; modelProfile?: string; promptHash?: string; outputHash?: string; reason?: string } = { status: "UNAVAILABLE", findings: [] };
  try {
    const run = await prisma.verificationRun.create({
      data: { studyId, workItemId, artifactRevisionId: artifact.id, kind: "SEMANTIC", status: "RUNNING", verifier: "orchestrator:semantic-verifier:v1", checks: { advisory: true }, inputHash: artifact.contentHash, startedAt: new Date() }
    });
    runId = run.id;
    const spec = contractSpec("assistant.verify.v1");
    const contract = await ensureContract(studyId, userId, "assistant.verify.v1");
    const specification = { request: requestFor(subject), subject: subject.kind, task: CHECKER_TASK };
    const evidence = buildEvidenceForChecker(subject);
    const inputHash = contentHash(specification);
    // The orchestrator checks the signature over exactly this payload. The work item is not stored: the second check
    // is advice and moves no state, so a signed one-shot contract is all the checker needs.
    const signedPayload = buildWorkItemSignedPayload({ studyId, requestedById: userId, contract, purpose: spec.purpose, inputHash, evidenceIds: evidence.map((entry) => entry.id), allowedTools: [], tokenBudget: spec.tokenBudget, timeBudgetSeconds: spec.timeBudgetSeconds, expiresAt: null });
    const signature = signControlPayload(signedPayload);
    const response = await verifyThroughOrchestrator(
      {
        workItem: {
          id: workItemId ?? `verify:${artifact.id}`,
          studyId,
          skillContractId: contract.id,
          role: "SEMANTIC_VERIFIER",
          purpose: spec.purpose,
          input: specification,
          inputHash,
          evidence,
          allowedTools: [],
          tokenBudget: spec.tokenBudget,
          timeBudgetSeconds: spec.timeBudgetSeconds,
          signature,
          signedPayload
        },
        proposal: buildProposalForChecker(subject)
      },
      { timeoutMs: input.timeoutMs ?? SECOND_CHECK_TIMEOUT_MS }
    );
    const interpreted = interpretVerification(response.output);
    outcome = { ...interpreted, modelProfile: response.execution.model, promptHash: response.execution.promptHash, outputHash: response.execution.outputHash };
  } catch (error) {
    // Names only: error messages can echo request content.
    outcome = { status: "UNAVAILABLE", findings: [], reason: error instanceof Error ? error.name : "unknown" };
  }

  try {
    const runStatus = outcome.status === "PASSED" ? "PASSED" : outcome.status === "CONCERNS" ? "FAILED" : "BLOCKED";
    if (runId) {
      await prisma.verificationRun.update({
        where: { id: runId },
        data: {
          status: runStatus,
          checks: { advisory: true, result: outcome.status, ...(outcome.reason ? { failure: outcome.reason } : {}) } as Prisma.InputJsonValue,
          findings: outcome.findings as unknown as Prisma.InputJsonValue,
          outputHash: outcome.outputHash ?? contentHash({ status: outcome.status, findings: outcome.findings }),
          modelProfile: outcome.modelProfile,
          promptHash: outcome.promptHash,
          completedAt: new Date()
        }
      });
    }
  } catch (error) {
    console.warn(`assistant-second-check: could not store the run (${error instanceof Error ? error.name : "unknown"})`);
  }
  await finish(outcome.status).catch(() => undefined);
  const rule = await prisma.verificationRun.findFirst({ where: { studyId, artifactRevisionId: artifact.id, kind: "DETERMINISTIC" }, orderBy: { createdAt: "desc" } }).catch(() => null);
  return { status: outcome.status, findings: outcome.findings, ruleCheck: rule ? (rule.status === "PASSED" ? "PASSED" : "FAILED") : null, cached: false };
}
