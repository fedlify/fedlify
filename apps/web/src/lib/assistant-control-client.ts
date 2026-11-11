/**
 * Pure helpers for the enforced-study screens: paused notices, the AI second check and the "why are you going ahead" reason.
 * No server imports. Nothing here is shown unless the server sent the enforced-study fields, so other studies look as before.
 */
import type { ControlView } from "@/lib/agent-thread-types";
import { SECOND_CHECK_TEXT, STOP_TEXT, type StopCode, type StopPayload } from "@/lib/terms";

export type VerificationStatus = NonNullable<ControlView["verificationStatus"]>;
export type Finding = ControlView["findings"][number];
export type Approval = NonNullable<ControlView["approval"]>;

export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 500;
/** Client-side limit on how often a pending check is asked about again (every 5 seconds). */
export const VERIFY_POLL_MS = 5000;
export const VERIFY_POLL_MAX = 24;

/** A stored message replaced by the safety check starts like this (see withheldNote in terms.ts). */
export function isWithheldNote(content: string): boolean {
  return content.startsWith("[Message withheld");
}

/** The stop carried by a NOTICE turn payload, or null when it is an ordinary notice. */
export function stopFromPayload(payload: unknown): StopPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const stop = (payload as { stop?: unknown }).stop;
  if (typeof stop !== "object" || stop === null) return null;
  const value = stop as Record<string, unknown>;
  if (typeof value.code !== "string" || typeof value.title !== "string") return null;
  const known = value.code in STOP_TEXT;
  const text = (known ? STOP_TEXT[value.code as StopCode] : null) ?? null;
  return {
    code: (known ? value.code : "POLICY_REFUSED") as StopCode,
    title: value.title,
    why: typeof value.why === "string" ? value.why : text?.why ?? "",
    whoDecides: typeof value.whoDecides === "string" ? value.whoDecides : text?.whoDecides ?? "",
    nextAction: typeof value.nextAction === "string" ? value.nextAction : text?.nextAction ?? "",
    codes: Array.isArray(value.codes) ? value.codes.filter((item): item is string => typeof item === "string") : undefined
  };
}

/** The control fields exist only for enforced studies (null status means "never ran"; absent means not enforced). */
export function isEnforced(item: { verificationStatus?: unknown } | null | undefined, controlMode?: string | null): boolean {
  return controlMode === "enforce" || (item != null && item.verificationStatus !== undefined);
}

/** A reason is needed to go ahead unless the second check passed. Only in enforced studies. */
export function reasonRequired(enforced: boolean, status: VerificationStatus | null | undefined): boolean {
  return enforced && status !== "PASSED";
}

export function validReason(text: string): boolean {
  return text.trim().length >= MIN_REASON_CHARS;
}

export function cleanReason(text: string): string {
  return text.trim().slice(0, MAX_REASON_CHARS);
}

/** Whether the screen should ask the server for the second check now. */
export function shouldRequestVerify(enforced: boolean, status: VerificationStatus | null | undefined, open: boolean): boolean {
  return enforced && open && (status === null || status === undefined || status === "CHECKING");
}

export type SecondCheckView = {
  tone: "info" | "success" | "warning";
  label: string;
  findings: Finding[];
  /** Show the note that this is advice from an AI check. */
  showAdvice: boolean;
  canRetry: boolean;
  /** Show the spinner. */
  checking: boolean;
};

export function secondCheckView(status: VerificationStatus | null | undefined, findings: Finding[] = [], working = false): SecondCheckView {
  if (working || status === "CHECKING" || status === null || status === undefined) {
    return { tone: "info", label: SECOND_CHECK_TEXT.checking, findings: [], showAdvice: false, canRetry: false, checking: true };
  }
  // A passed check can still carry notes (for example "could not judge this part"); they need no reason.
  if (status === "PASSED") return { tone: "success", label: findings.length > 0 ? SECOND_CHECK_TEXT.passedWithNotes : SECOND_CHECK_TEXT.passed, findings, showAdvice: true, canRetry: false, checking: false };
  if (status === "CONCERNS") return { tone: "warning", label: SECOND_CHECK_TEXT.concerns, findings, showAdvice: true, canRetry: false, checking: false };
  return { tone: "warning", label: SECOND_CHECK_TEXT.unavailable, findings: [], showAdvice: false, canRetry: true, checking: false };
}

export const FINDING_KIND_LABEL: Record<Finding["kind"], string> = {
  contradiction: "Does not match what was asked",
  beyond_request: "Goes beyond what was asked",
  other: "Note"
};

/** One plain sentence for the dialog that asks why the person is going ahead. */
export function reasonNote(status: VerificationStatus | null | undefined): string {
  if (status === "CONCERNS") return "The second check found things to look at. You can still go ahead if you give a reason.";
  if (status === "UNAVAILABLE") return "The second check could not run. You can still go ahead if you give a reason.";
  return "The second check has not finished. You can still go ahead if you give a reason.";
}

/** Reads the status, findings and rule check out of a verify route answer. Returns null for anything unexpected. */
export function readVerification(body: unknown): { status: VerificationStatus; findings: Finding[]; ruleCheck: "PASSED" | "FAILED" | null } | null {
  const verification = (body as { verification?: Record<string, unknown> } | null)?.verification;
  if (!verification || typeof verification !== "object") return null;
  const status = verification.status;
  if (status !== "CHECKING" && status !== "PASSED" && status !== "CONCERNS" && status !== "UNAVAILABLE") return null;
  const findings = Array.isArray(verification.findings)
    ? verification.findings.filter((item): item is Finding => typeof item === "object" && item !== null && typeof (item as Finding).text === "string").slice(0, 8)
    : [];
  const ruleCheck = verification.ruleCheck === "PASSED" || verification.ruleCheck === "FAILED" ? verification.ruleCheck : null;
  return { status, findings, ruleCheck };
}

/** "Approved by Dr. Lee" and, when the person approved their own work, "(self-approved)". Empty when there is no approval. */
export function approvalLabel(approval: Approval | null | undefined): string {
  if (!approval) return "";
  if (!approval.valid) return "The earlier approval no longer applies because this changed afterwards.";
  const who = approval.approvedByName?.trim() || "a team member";
  return `Approved by ${who}${approval.selfApproved ? " (self-approved)" : ""}`;
}

/** Plain message for the publish refusal that asks for another approver. */
export function publishRefusalText(code: string | undefined, message: string): string | null {
  return code === "second_approver_required" ? message : null;
}
