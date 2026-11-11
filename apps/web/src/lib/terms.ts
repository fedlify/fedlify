/**
 * Plain-language vocabulary for everything a non-technical reader sees.
 * Client-safe: no node, prisma or other runtime imports. Keys (enum values, audit action keys) are never renamed
 * here; only the words shown to people are defined.
 */

export const TERMS = {
  studyServer: "Study server",
  siteKit: "Site kit",
  pipeline: "Pipeline",
  newPipeline: "New pipeline",
  pipelineVersion: "Pipeline version",
  save: "Save",
  publishLatest: "Publish latest saved code",
  runner: "Runner",
  runnerConnected: "Connected",
  runnerNotConnected: "Not connected",
  runnerNotReporting: "Not reporting",
  site: "Site",
  siteId: "Site ID",
  siteChecks: "Site checks",
  siteSignOff: "Site sign-off",
  studyQuestions: "Study questions",
  codeVersion: "Code version",
  codeVersionUpToDate: "Code version: up to date",
  codeVersionNeedsUpdate: "Code version: needs update",
  run: "Run",
  modelRelease: "Model release",
  repository: "repository",
  openRepository: "Open repository",
  details: "Details"
} as const;

function sentenceCase(value: string): string {
  const text = value.replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

/** One label per status-like enum value. Values shared by several enums share one plain label. */
export const STATUS_LABELS: Record<string, string> = {
  // Generic
  UNKNOWN: "Unknown",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
  DRAFT: "Draft",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  FAILED: "Failed",
  PASSED: "Passed",
  PASS: "Passed",
  WARN: "Warning",
  WARNING: "Warning",
  QUEUED: "Waiting to start",
  RUNNING: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  SUPERSEDED: "Replaced by a newer one",
  BLOCKED: "Blocked",
  OPEN: "Open",
  CLOSED: "Closed",
  DONE: "Done",
  READY: "Ready",
  NEXT: "Next",
  OPTIONAL: "Optional",
  EVENT: "Event",
  CLEAN: "Clean",
  INTAKE: "Intake",
  NEEDS_ATTENTION: "Needs attention",
  NOT_STARTED: "Not started",
  NOT_CREATED: "Not created",
  NOT_RELEASED: "Saved, not released",
  RELEASED: "Released",
  PENDING_CHANGES: "Unsaved changes",
  OUTDATED: "Needs update",
  DELETED: "Deleted",
  RETIRED: "Retired",
  PAUSED: "Paused",
  STALE: "Out of date",
  // MembershipStatus
  SUSPENDED: "Suspended",
  // StudyStatus / GovernanceStatus
  INCOMPLETE: "Incomplete",
  PENDING_APPROVAL: "Waiting for approval",
  // InvitationStatus
  ACCEPTED: "Accepted",
  INVITED: "Invited",
  // EthicsStatus
  NOT_REQUIRED: "Not required",
  // NeedSubmissionStatus
  SUBMITTED: "Submitted",
  // AgentRunStatus
  DRAFT_READY: "Draft ready for review",
  VALIDATED: "Checked",
  // ComputeRunStatus
  SUCCEEDED: "Succeeded",
  // SiteStatus (shown as runner connection)
  KIT_RELEASED: "Site kit ready",
  CONNECTED: "Connected",
  NOT_CONNECTED: "Not connected",
  NOT_REPORTING: "Not reporting",
  DEGRADED: "Connection unstable",
  OFFLINE: "Not reporting",
  DISABLED: "Disabled",
  // PipelineVersionStatus
  VALIDATING: "Being checked",
  // AgentProposalStatus
  MERGED: "Saved",
  PROPOSED: "Proposed",
  // TemplateAgentSessionStatus
  CODING: "Writing code",
  APPLIED: "Applied",
  // NvflareDeploymentStatus
  PROVISIONED: "Set up",
  // NvflareJobStatus / NvflareJobEventType
  SCHEDULED: "Scheduled",
  ABORTED: "Stopped",
  STARTED: "Started",
  SITE_UPDATE: "Site update",
  METRIC_UPDATE: "Metrics updated",
  LOG_AVAILABLE: "Log available",
  EXECUTED: "Carried out",
  // ControlState
  CLASSIFIED: "Sorted",
  QUARANTINED: "Held for review",
  POLICY_AUTHORIZED: "Allowed by policy",
  WORK_ITEM_SIGNED: "Task signed",
  EVIDENCE_ASSEMBLED: "Evidence gathered",
  WORKER_COMPLETED: "Work completed",
  DETERMINISTIC_VERIFIED: "Automatic checks passed",
  SEMANTIC_VERIFIED: "Content checks passed",
  HUMAN_APPROVED: "Approved by a person",
  EXPORTED: "Exported",
  STOPPED: "Stopped",
  // StopCondition
  STOP_1_INTAKE: "Stopped at intake",
  STOP_2_EVIDENCE: "Stopped at evidence",
  STOP_3_READINESS: "Stopped at site checks",
  STOP_4_DETERMINISTIC_VERIFICATION: "Stopped at automatic checks",
  STOP_5_POLICY: "Stopped at policy",
  STOP_6_HUMAN_APPROVAL: "Stopped at approval",
  STOP_7_EXPORT_RUNTIME: "Stopped at export",
  // WorkItemStatus
  SIGNED: "Signed",
  // FactStatus
  CONFIRMED: "Confirmed",
  INVALIDATED: "No longer valid",
  // EvidenceClassification
  CURATED: "Reviewed",
  UNTRUSTED: "Not trusted",
  SENSITIVE: "Sensitive",
  // VerificationStatus
  // QuarantineStatus
  HELD: "Held",
  // InvalidationStatus
  ACKNOWLEDGED: "Acknowledged",
  RESOLVED: "Resolved",
  // ProbeDisposition
  WRONG_LAYER: "Stopped for a different reason",
  NOT_BLOCKED: "Not blocked",
  INFRA_FAILURE: "Platform problem",
  // RegistryRobotStatus
  REVOKING: "Being revoked",
  // AgentTurnKind (conversation items)
  MESSAGE: "Message",
  QUESTIONS: "Questions",
  ANSWERS: "Answers",
  PLAN: "Plan",
  PLAN_DECISION: "Plan decision",
  PROPOSAL: "Proposal",
  NOTICE: "Notice",
  // AgentTurnRole
  ASSISTANT: "Assistant"
};

/** Plain label for a status value. Accepts enum text in any case; unknown values become sentence case. */
/** Site kit state wording, shared by every screen so it cannot drift. */
export const KIT_STATE_LABELS: Record<"NOT_RELEASED" | "RELEASED" | "OUTDATED", string> = {
  NOT_RELEASED: "Not created yet",
  RELEASED: "Ready",
  OUTDATED: "New site kit needed"
};

export function kitStateLabel(state?: string | null): string {
  return KIT_STATE_LABELS[state as keyof typeof KIT_STATE_LABELS] ?? "Not created yet";
}

export function statusLabel(value?: string | null): string {
  const raw = String(value ?? "").trim();
  if (!raw) return STATUS_LABELS.UNKNOWN;
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(STATUS_LABELS, key)) return STATUS_LABELS[key];
  if (Object.prototype.hasOwnProperty.call(ROLE_LABELS, key)) return ROLE_LABELS[key];
  return sentenceCase(raw);
}

/** Every StudyRole, SiteRole, OrgRole and PlatformRole value. */
export const ROLE_LABELS: Record<string, string> = {
  // StudyRole
  PRINCIPAL_INVESTIGATOR: "Principal investigator",
  STUDY_OWNER: "Study owner",
  STUDY_COORDINATOR: "Study coordinator",
  CLINICAL_LEAD: "Clinical lead",
  ETHICS_REVIEWER: "Ethics reviewer",
  DATA_SCIENTIST: "Data scientist",
  PIPELINE_DEVELOPER: "Pipeline developer",
  PRIVACY_SECURITY_OFFICER: "Privacy and security officer",
  RELEASE_APPROVER: "Release approver",
  SITE_ADMIN: "Site administrator",
  AUDITOR: "Auditor",
  // SiteRole
  SITE_PI: "Site principal investigator",
  SITE_DATA_STEWARD: "Site data steward",
  SITE_ENGINEER: "Site engineer",
  SITE_REVIEWER: "Site reviewer",
  // OrgRole
  ORG_ADMIN: "Organization administrator",
  MEMBER: "Member",
  // PlatformRole
  USER: "User",
  PLATFORM_ADMIN: "Platform administrator"
};

export function roleLabel(role?: string | null): string {
  const raw = String(role ?? "").trim();
  if (!raw) return "Unknown role";
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, key) ? ROLE_LABELS[key] : sentenceCase(raw);
}

/** Plain past-tense label for every audit action key written by the code. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.register": "Created an account",
  "case-study.protocol.create": "Created a case study protocol",
  "case-study.protocol.approve": "Approved a case study protocol",
  "control.approval.bind": "Recorded an approval",
  "control.artifact.create": "Added a document version",
  "control.evidence.intake": "Added evidence",
  "control.export.create": "Prepared an export",
  "control.fact.propose": "Proposed a study fact",
  "control.fact.confirm": "Confirmed a study fact",
  "control.intake.authoritative": "Recorded the study intake",
  "control.skill-contract.create": "Set up an assistant task",
  "control.verification.record": "Recorded a check result",
  "control.work-item.create": "Created a task",
  "control.work-item.execute": "Ran a task",
  "control.work-item.transition": "Moved a task to the next step",
  "document.create": "Uploaded a document",
  "ethics.record": "Recorded an ethics approval",
  "ethics.update": "Updated an ethics approval",
  "invitation.create": "Sent an invitation",
  "invitation.accept": "Accepted an invitation",
  "invitation.site.create": "Invited a person to a site",
  "invitation.site.accept": "Accepted a site invitation",
  "invitation.revoke": "Cancelled an invitation",
  "model_release.promote": "Created a model release",
  "model_release.approve": "Approved a model release",
  "model_release.download": "Downloaded a model release",
  "nvflare.deployment.provision": "Set up the study server",
  "nvflare.deployment.start": "Started the study server",
  "nvflare.deployment.stop": "Stopped the study server",
  "nvflare.job.submit": "Started a run",
  "nvflare.job.abort": "Stopped a run",
  "nvflare.job_result.sync": "Collected run results",
  "pipeline.agent_proposal.create": "Created a suggested code change",
  "pipeline.version.approve": "Approved a pipeline version",
  "pipeline.version.download": "Downloaded a pipeline version",
  "pipeline_project.agent_accept_refused": "Could not apply a suggested change",
  "pipeline_project.agent_commit_reconciled": "Matched a saved change to its suggestion",
  "pipeline_project.agent_message": "Sent a message to the assistant",
  "pipeline_project.agent_plan": "Assistant proposed a plan",
  "pipeline_project.agent_plan_approve": "Approved the assistant's plan",
  "pipeline_project.agent_plan_invalid": "Assistant plan could not be used",
  "pipeline_project.agent_stopped": "The assistant was paused for a safety reason",
  "pipeline_project.agent_plan_questions": "Assistant asked questions",
  "pipeline_project.agent_plan_reject": "Rejected the assistant's plan",
  "pipeline_project.agent_plan_stale": "Assistant plan became out of date",
  "pipeline_project.agent_proposal": "Assistant suggested a code change",
  "pipeline_project.agent_proposal_rejected": "Assistant suggestion was not usable",
  "pipeline_project.agent_reject": "Rejected a suggested code change",
  "pipeline_project.agent_save": "Saved a suggested code change",
  "pipeline_project.clone": "Copied a pipeline",
  "pipeline_project.import": "Imported a pipeline",
  "pipeline_project.import_orphan_repo": "Found an unused pipeline copy during import",
  "pipeline_project.import_preview": "Previewed a pipeline import",
  "pipeline_project.import_rejected": "Pipeline import was refused",
  "pipeline_project.publish": "Published a pipeline version",
  "pipeline_project.save": "Saved pipeline code",
  "pipeline_project.thread_archive": "Archived an assistant conversation",
  "pipeline_project.thread_create": "Started an assistant conversation",
  "pipeline_project.thread_rename": "Renamed an assistant conversation",
  "pipeline_project.thread_view_other": "Viewed another person's assistant conversation",
  "pipeline_template.proposal.create": "Proposed a pipeline template",
  "pipeline_template.proposal.approve": "Approved a pipeline template",
  "registry.project.ensure": "Prepared the code version storage",
  "registry.project.reactivate": "Reopened the code version storage",
  "registry.robot.create": "Gave a site download access to the code version",
  "registry.robot.delete": "Removed a site's download access",
  "registry.robot.delete_failed": "Could not remove a site's download access",
  "registry.robot.expired_swept": "Removed expired download access",
  "registry.robot.orphan_swept": "Removed unused download access",
  "registry.robot.unexpected": "Found unexpected download access",
  "release.download": "Downloaded a release",
  "studyMember.roles.update": "Changed a person's study roles",
  "site.create": "Added a site",
  "site.governance.update": "Updated a site's approvals",
  "site.join_package.create": "Created a site kit",
  "site.join_package.create_failed": "Could not create a site kit",
  "site.join_package.download": "Downloaded a site kit",
  "site.join_package.download_authorized": "Allowed a site kit download",
  "site.join_package.download_failed": "Could not download a site kit",
  "site.member.assign": "Assigned a person to a site",
  "site.member.remove": "Removed a person from a site",
  "site.policy.accept": "Accepted the site policy",
  "site.status_changed": "Site connection changed",
  "site.token.rotate": "Replaced the site access code",
  "study.create": "Created the study",
  "study.update": "Updated the study",
  "study.activate": "Activated the study",
  "study.archive": "Archived the study",
  "study.reactivate": "Reactivated the study",
  "study.audit.export": "Exported the activity log",
  "study.gitea_workspace.ensure": "Prepared the code repository",
  "study.publish.succeeded": "Published the study successfully",
  "study.publish.failed": "Study publishing failed",
  "study.requirement.answer": "Answered a study question",
  "study_template.create": "Created a study template",
  "study_template.approve": "Approved a study template",
  "study_template.fork": "Copied a study template",
  "study_template.propose_public": "Proposed sharing a template publicly",
  "template_agent.apply": "Applied an assistant template draft",
  "template_review.apply": "Applied a template review",
  "argo.webhook": "Received a publishing update"
};

/** Readable label for an audit action key; unknown keys fall back to sentence case of the last words. */
export function auditActionLabel(action?: string | null): string {
  const raw = String(action ?? "").trim();
  if (!raw) return "Activity";
  if (Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABELS, raw)) return AUDIT_ACTION_LABELS[raw];
  const failed = raw.endsWith("_failed") ? raw.slice(0, -"_failed".length) : null;
  if (failed && Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABELS, failed)) {
    return `Failed attempt: ${AUDIT_ACTION_LABELS[failed].toLowerCase()}`;
  }
  const parts = raw.split(".");
  const tail = parts.slice(-2).join(" ");
  return sentenceCase(tail);
}

// ---------- Assistant stops (control plane enforcement) ----------

export type StopCode =
  | "SENSITIVE_CONTENT"
  | "RAW_CLINICAL_DATA"
  | "ACTIVE_CONTENT"
  | "PROMPT_INJECTION"
  | "MODEL_UPDATE_ARTIFACT"
  | "POLICY_REFUSED"
  | "CHECK_UNAVAILABLE";

/** What a paused assistant turn carries (AgentTurn.payload.stop). Plain text for people; `code` is the technical key. */
export type StopPayload = {
  code: StopCode;
  title: string;
  why: string;
  whoDecides: string;
  nextAction: string;
  /** Every technical reason code that applied, for the Details section. */
  codes?: string[];
};

type StopText = Omit<StopPayload, "code" | "codes"> & {
  /** Short reason used in the note that replaces a withheld message. Empty when the message is not withheld. */
  reason: string;
};

/** One plain-language text per reason a message is paused. Used by the server to build the stop and by screens to show it. */
export const STOP_TEXT: Record<StopCode, StopText> = {
  SENSITIVE_CONTENT: {
    title: "The message looked like it held a secret",
    why: "It looked like it contained a password, key or other secret. Secrets are not sent to the assistant and are not kept in the chat.",
    whoDecides: "You decide. Study owners can help if you are unsure.",
    nextAction: "Remove the secret and send the message again.",
    reason: "a password, key or other secret"
  },
  RAW_CLINICAL_DATA: {
    title: "The message looked like it held patient data",
    why: "It looked like it contained rows of patient-level data. Patient data must stay at the sites and is never sent to the assistant.",
    whoDecides: "You decide. Your site data steward can confirm what may be shared.",
    nextAction: "Describe the data in words, or remove the rows, and send the message again.",
    reason: "patient-level data"
  },
  ACTIVE_CONTENT: {
    title: "The message held content that could run",
    why: "It contained script or other content that can run on its own. The assistant only works with plain text.",
    whoDecides: "You decide.",
    nextAction: "Remove the script or paste the part you need as plain text, then send the message again.",
    reason: "content that could run on its own"
  },
  PROMPT_INJECTION: {
    title: "The message tried to change the assistant's rules",
    why: "It looked like an instruction to ignore the assistant's safety rules.",
    whoDecides: "You decide. A study owner can look at it if this was a mistake.",
    nextAction: "Rephrase the request without instructions about the assistant's rules.",
    reason: "an instruction to ignore the assistant's rules"
  },
  MODEL_UPDATE_ARTIFACT: {
    title: "The message held model weights",
    why: "It looked like it contained model weights or training updates. These are only shared through a model release.",
    whoDecides: "A study owner decides what may be shared.",
    nextAction: "Remove the weights and describe what you need in words.",
    reason: "model weights or training updates"
  },
  POLICY_REFUSED: {
    title: "The safety rules do not allow this",
    why: "The safety rules for this study did not allow the assistant to handle this request.",
    whoDecides: "A study owner decides.",
    nextAction: "Ask a study owner to check the safety rules for this study.",
    reason: ""
  },
  CHECK_UNAVAILABLE: {
    title: "The safety check could not run",
    why: "The safety check could not be completed, so nothing was sent to the assistant.",
    whoDecides: "No decision is needed.",
    nextAction: "Try again in a minute. If it keeps happening, tell a study owner.",
    reason: ""
  }
};

const STOP_CODE_ORDER: StopCode[] = ["SENSITIVE_CONTENT", "RAW_CLINICAL_DATA", "ACTIVE_CONTENT", "PROMPT_INJECTION", "MODEL_UPDATE_ARTIFACT", "POLICY_REFUSED", "CHECK_UNAVAILABLE"];

function isStopCode(code: string): code is StopCode {
  return (STOP_CODE_ORDER as string[]).includes(code);
}

/** Turn the reason codes of a stop into the payload shown to people. The most serious known code leads; unknown codes count as a policy stop. */
export function stopPayloadFor(codes: string[]): StopPayload {
  const known = STOP_CODE_ORDER.filter((code) => codes.includes(code));
  const code: StopCode = known[0] ?? "POLICY_REFUSED";
  const { reason: _reason, ...text } = STOP_TEXT[code];
  return { code, ...text, codes: [...new Set(codes)] };
}

/** The short note stored in place of a withheld message. Never includes the message. */
export function withheldNote(code: StopCode): string {
  const reason = STOP_TEXT[code].reason;
  return reason ? `[Message withheld: it looked like it contained ${reason}.]` : "[Message withheld.]";
}

/** True for the note stored in place of a withheld message. */
export function isWithheldNote(content: string): boolean {
  return content.startsWith("[Message withheld");
}

/** Plain words for the AI second check. */
export const SECOND_CHECK_TEXT = {
  checking: "Checking…",
  passed: "Second check passed",
  concerns: "Second check found things to look at",
  unavailable: "Could not check: needs your decision",
  advice: "This is advice from an AI check. It can be wrong. You decide.",
  reasonPrompt: "Why are you going ahead?"
} as const;
