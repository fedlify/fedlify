/**
 * Shared contracts for agent threads, plan mode and the changes timeline.
 * Pure types and constants: no server imports, so routes, libs and client components can all use it.
 * Audit metadata must never carry message text; AUDIT_ACTIONS lists the actions this feature writes.
 */

import type { StopPayload } from "@/lib/terms";

export const THREAD_MODES = ["ask", "plan", "agent"] as const;
export type ThreadMode = (typeof THREAD_MODES)[number];
/** Modes a single turn may be sent in. "agent" is a UI mode that runs plan, waits for approval, then code. */
export const TURN_MODES = ["ask", "plan"] as const;
export type TurnMode = (typeof TURN_MODES)[number];

export type ThreadStatus = "ACTIVE" | "ARCHIVED";
export type TurnRole = "USER" | "ASSISTANT";
export type TurnKind = "MESSAGE" | "QUESTIONS" | "ANSWERS" | "PLAN" | "PLAN_DECISION" | "PROPOSAL" | "NOTICE";
export type TurnStatus = "streaming" | "done" | "error" | "stopped";
export type PlanStatus = "DRAFT" | "APPROVED" | "REJECTED" | "SUPERSEDED" | "STALE" | "EXECUTED";

export const LIMITS = {
  titleChars: 80,
  turnContentChars: 20_000,
  /** A turn still "streaming" after this long is reported as "stopped" when read. */
  streamingStaleMs: 5 * 60 * 1000,
  maxQuestionRounds: 3,
  maxQuestionsPerRound: 5,
  threadPageSize: 30,
  turnPageSize: 200
} as const;

/** Thread-level state derived from turns and plan status (design 2.5). */
export type ThreadPhase =
  | "CHATTING"
  | "TRIAGE"
  | "NEEDS_INPUT"
  | "PLAN_DRAFT"
  | "PLAN_APPROVED"
  | "PROPOSED"
  | "ACCEPTED"
  | "REJECTED"
  | "STALE";

// ---------- turn payloads (AgentTurn.payload, by kind) ----------

export type QuestionOption = { id: string; label: string; recommended?: boolean };
export type PlanQuestion = {
  id: string;
  text: string;
  options: QuestionOption[];
  multi: boolean;
  allowOther: boolean;
  /** Set when the question is about a blank study requirement. */
  requirementKey?: string;
};
/** kind QUESTIONS */
export type QuestionsPayload = { round: number; questions: PlanQuestion[] };
/** kind ANSWERS: question id to option id, option ids (multi) or free text. */
export type AnswersPayload = { questionsTurnId: string; answers: Record<string, string | string[]>; skipped?: boolean };

export type PlanStepAction = "create" | "update" | "delete";
export type PlanStepRisk = "low" | "medium" | "high";
export type PlanStep = {
  id: string;
  title: string;
  paths: string[];
  action: PlanStepAction;
  rationale: string;
  risk: PlanStepRisk;
  optional: boolean;
  /** Default selection in the UI. */
  enabled: boolean;
};
export type PlanAssumption = { id: string; text: string; needsAck: boolean };

/** kind PLAN and PLAN_DECISION reference the plan row; PROPOSAL references the proposal row. */
export type PlanTurnPayload = { planId: string };
export type PlanDecisionPayload = { planId: string; decision: PlanDecision; approvedStepIds?: string[] };
export type ProposalTurnPayload = { proposalId: string };
/** A NOTICE turn written when the control plane paused the assistant (enforced studies only). */
export type StopTurnPayload = { stop: StopPayload };
export type TurnPayload = QuestionsPayload | AnswersPayload | PlanTurnPayload | PlanDecisionPayload | ProposalTurnPayload | StopTurnPayload | null;

export type PlanDecision = "approve" | "reject";

export type EditorSelection = { startLine: number; endLine: number; text?: string };

// ---------- DTOs ----------

export type ThreadSummaryDto = {
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  mode: ThreadMode;
  turnCount: number;
  lastTurnAt: string;
  createdAt: string;
  createdBy: { id: string; name: string | null };
  /** True when the viewer is not the author. */
  foreign: boolean;
  /** Latest plan status, for the history row badge. */
  planStatus: PlanStatus | null;
  proposalCount: number;
};

export type TurnDto = {
  id: string;
  threadId: string;
  seq: number;
  role: TurnRole;
  kind: TurnKind;
  content: string;
  payload: TurnPayload;
  status: TurnStatus;
  actorUserId: string | null;
  model: string | null;
  promptVersion: string | null;
  contextHash: string | null;
  baseCommit: string | null;
  filePath: string | null;
  selection: EditorSelection | null;
  clientTurnId: string | null;
  planId: string | null;
  proposalId: string | null;
  createdAt: string;
};

export type PlanDto = {
  id: string;
  threadId: string;
  version: number;
  summary: string;
  steps: PlanStep[];
  assumptions: PlanAssumption[];
  baseCommit: string;
  contextHash: string;
  requirementsHash: string;
  status: PlanStatus;
  approvedStepIds: string[] | null;
  decidedById: string | null;
  decidedAt: string | null;
  createdAt: string;
} & Partial<ControlView>;

/** Added to plans and proposals only when the study enforces the control plane. */
export type ControlView = {
  /** The AI second check: CHECKING | PASSED | CONCERNS | UNAVAILABLE, or null when it has not run. */
  verificationStatus: "CHECKING" | "PASSED" | "CONCERNS" | "UNAVAILABLE" | null;
  findings: { kind: "contradiction" | "beyond_request" | "other"; text: string }[];
  /** The rule-based check that ran when the item was made. */
  ruleCheck: "PASSED" | "FAILED" | null;
  approval: { approvedById: string | null; approvedByName: string | null; selfApproved: boolean; valid: boolean; approvedAt: string | null } | null;
};

/** Proposal as shown in a thread: no file contents. */
export type ThreadProposalDto = {
  id: string;
  title: string;
  status: string;
  baseCommit: string | null;
  acceptedCommit: string | null;
  acceptedPaths: string[] | null;
  planId: string | null;
  turnId: string | null;
  files: { path: string; action: PlanStepAction; added: number; removed: number }[];
  createdAt: string;
  decidedAt: string | null;
  rejectedById: string | null;
  rejectedAt: string | null;
} & Partial<ControlView>;

export type ThreadAccessLevel = "author" | "manager" | "auditor";

export type ThreadDetailDto = {
  thread: ThreadSummaryDto;
  access: { level: ThreadAccessLevel; readOnly: boolean; canDecidePlan: boolean; canArchive: boolean };
  turns: TurnDto[];
  plans: PlanDto[];
  proposals: ThreadProposalDto[];
  phase: ThreadPhase;
  hasMore: boolean;
  /** "enforce" when the control plane is enforced for this study; absent otherwise. */
  controlMode?: "enforce";
};

/** What the audit role gets: no turns, plans or text. */
export type ThreadMetadataDto = { thread: ThreadSummaryDto; access: ThreadDetailDto["access"]; metadataOnly: true };

// ---------- request bodies ----------

export type SendTurnBody = {
  message: string;
  mode: TurnMode;
  clientTurnId: string;
  filePath?: string;
  selection?: EditorSelection;
  diagnostics?: boolean;
};
export type AnswersBody = { turnId: string; answers: Record<string, string | string[]>; skipped?: boolean };
export type PlanDecisionBody = { decision: PlanDecision; approvedStepIds?: string[]; ackAssumptions?: string[]; /** Why the person goes ahead when the second check found concerns or could not run. */ proceedReason?: string };

// ---------- error codes ----------

export const THREAD_ERROR_CODES = {
  disabled: "threads_disabled",
  planStale: "plan_stale",
  planNotApproved: "plan_not_approved",
  assumptionsNotAcknowledged: "assumptions_not_acknowledged",
  threadArchived: "thread_archived",
  readOnly: "thread_read_only"
} as const;

// ---------- SSE ----------

/** Existing events (assistant-stream.ts) stay; these are added. */
export const THREAD_SSE_EVENTS = {
  stop: "fedlify.stop",
  turn: "fedlify.turn",
  questions: "fedlify.questions",
  plan: "fedlify.plan"
} as const;
export type ThreadSseEventName = (typeof THREAD_SSE_EVENTS)[keyof typeof THREAD_SSE_EVENTS];

/** The assistant was paused. `turnId` is the stored NOTICE turn; userTurnId is null when the message was not stored. */
export type StopEventData = { threadId: string; turnId: string; seq: number; userTurnId: string | null; stop: StopPayload };
export type TurnEventData = { threadId: string; userTurnId: string; userSeq: number; assistantTurnId: string; assistantSeq: number };
export type QuestionsEventData = { threadId: string; turnId: string; seq: number; payload: QuestionsPayload };
export type PlanEventData = { threadId: string; turnId: string; seq: number; plan: PlanDto };

// ---------- audit ----------

export const AUDIT_ACTIONS = {
  threadCreate: "pipeline_project.thread_create",
  threadRename: "pipeline_project.thread_rename",
  threadArchive: "pipeline_project.thread_archive",
  threadViewOther: "pipeline_project.thread_view_other",
  planQuestions: "pipeline_project.agent_plan_questions",
  plan: "pipeline_project.agent_plan",
  planApprove: "pipeline_project.agent_plan_approve",
  planReject: "pipeline_project.agent_plan_reject",
  planStale: "pipeline_project.agent_plan_stale",
  commitReconciled: "pipeline_project.agent_commit_reconciled"
} as const;
export type ThreadAuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Keys that must never appear in thread audit metadata. */
export const FORBIDDEN_AUDIT_KEYS = ["message", "content", "text", "prompt", "answers", "title", "summary"] as const;

// ---------- timeline ----------

export type TimelineKind = "agent" | "manual" | "published" | "rejected" | "external";
export type TimelineEntryDto = {
  id: string;
  kind: TimelineKind;
  at: string;
  commit: string | null;
  title: string;
  actor: { id: string | null; name: string | null };
  threadId: string | null;
  proposalId: string | null;
  proposalStatus: string | null;
  turnId: string | null;
  added: number | null;
  removed: number | null;
  published: { version: number; approvedByName: string | null } | null;
};
export type TimelinePageDto = { entries: TimelineEntryDto[]; nextCursor: string | null };
