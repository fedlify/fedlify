import type { EthicsStatus, GovernanceStatus, PipelineVersionStatus } from "@prisma/client";
import { siteSignedOff, type SiteSignoffInput } from "@/lib/site-signoff";
import { REQUIREMENT_ORDER, type RequirementId } from "@/lib/requirements-catalog";

type ProtocolMetadata = {
  title?: string | null;
  goal?: string | null;
  researchQuestion?: string | null;
  hypothesis?: string | null;
  secondaryObjectives?: string | null;
  studyDesign?: string | null;
  clinicalUseCase?: string | null;
  population?: string | null;
  eligibilityCriteria?: string | null;
  dataModalities?: string | null;
  primaryOutcome?: string | null;
  primaryEndpointDetails?: string | null;
  secondaryOutcomes?: string | null;
  sampleSizeRationale?: string | null;
  analysisPlan?: string | null;
  dataHandlingPlan?: string | null;
  humanAiWorkflow?: string | null;
  fairnessPlan?: string | null;
  disseminationPlan?: string | null;
  intendedUse?: string | null;
};

type EthicsRecord = {
  status: EthicsStatus;
  /** When the decision stops being valid (null/absent = no end date). */
  validUntil?: Date | string | null;
};

/** The latest readiness check of a site (null = none recorded). Only the human sign-off fields count. */
type SiteReadiness = SiteSignoffInput | null;

type StudyActivationInput = ProtocolMetadata & {
  ethics?: EthicsRecord[];
  studySites?: unknown[];
  // When provided, every one of the 29 requirements must be answered before activation
  // (requirements are part of protocol definition, so they are gathered before the study goes live).
  requirementResponses?: Array<{ requirementId: string; status?: string | null }>;
  // Alternative to requirementResponses when only the counts are known (the Summary page).
  questions?: { answered: number; total?: number };
};

type PipelineExecutionInput = {
  ethicsStatus?: EthicsStatus | null;
  ethicsValidUntil?: Date | string | null;
  pipelineApprovalStatus?: PipelineVersionStatus | null;
  pipelineValidationStatus?: string | null;
  readinessChecks: SiteReadiness[];
};

/** What a study needs in its own text before it can start: a title and an objective. The other study details are encouraged, not required. */
export const REQUIRED_PROTOCOL_FIELDS: Array<keyof ProtocolMetadata> = ["title", "goal"];

/** Plain labels for the fields above, used in every message about what is missing. */
export const REQUIRED_FIELD_LABELS: Record<string, string> = { title: "Study title", goal: "Study objective" };

/** Text of a stored value without markup: older studies saved rich text (HTML) in these fields. */
export function meaningfulProtocolText(value: unknown) {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function missingProtocolFields(study: ProtocolMetadata): string[] {
  return REQUIRED_PROTOCOL_FIELDS.filter((field) => {
    const value = study[field];
    return typeof value !== "string" || meaningfulProtocolText(value).length === 0;
  });
}

export function latestEthicsStatus(ethics?: EthicsRecord[]): EthicsStatus | null {
  return ethics?.[0]?.status ?? null;
}

/** The end date of the latest ethics decision, or null when there is none. */
export function latestEthicsValidUntil(ethics?: EthicsRecord[]): Date | string | null {
  return ethics?.[0]?.validUntil ?? null;
}

/** True when the decision has an end date that is already in the past. */
export function ethicsExpired(validUntil?: Date | string | null, now: Date = new Date()): boolean {
  if (!validUntil) return false;
  const end = new Date(validUntil).getTime();
  return Number.isFinite(end) && end < now.getTime();
}

function formatEthicsDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Plain sentence for an expired ethics decision. */
export function ethicsExpiredMessage(validUntil: Date | string): string {
  return `The ethics decision expired on ${formatEthicsDate(validUntil)}. Record the renewed decision.`;
}

/** An approval whose end date has passed is not cleared, whatever its status says. */
export function ethicsCleared(status?: EthicsStatus | null, validUntil?: Date | string | null, now: Date = new Date()): boolean {
  if (status !== "APPROVED" && status !== "NOT_REQUIRED") return false;
  return !ethicsExpired(validUntil, now);
}

/**
 * The one rule for starting a study, used by create, update and the deployment route: a title, an objective, a cleared
 * ethics decision, at least one site, and all 29 study questions answered or assumed. `missing` holds plain labels.
 */
export function activationGate(study: StudyActivationInput): { allowed: boolean; missing: string[]; status: GovernanceStatus } {
  const missing = missingProtocolFields(study).map((field) => REQUIRED_FIELD_LABELS[field] ?? field);
  if (!ethicsCleared(latestEthicsStatus(study.ethics), latestEthicsValidUntil(study.ethics))) missing.push("Ethics decision");
  // Disabled sites do not take part, so they do not count (the same rule as Summary and the run checklist).
  const takingPart = (study.studySites ?? []).filter((site) => (site as { participationStatus?: string } | null)?.participationStatus !== "DISABLED");
  if (!takingPart.length) missing.push("At least one site");

  const total = REQUIREMENT_ORDER.length;
  const answered = study.requirementResponses ? total - requirementsGate(study.requirementResponses).missing.length : study.questions?.answered;
  if (answered !== undefined && answered < total) missing.push(`Study questions (${answered} of ${total} answered)`);

  if (missing.length > 0) {
    return { allowed: false, missing, status: "INCOMPLETE" };
  }

  return { allowed: true, missing: [], status: "APPROVED" };
}

/** A row counts as answered when a person put it there: ANSWERED, ASSUMED, or a row from before statuses existed (no status). */
export function countsAsAnswered(status?: string | null): boolean {
  return status == null || status === "ANSWERED" || status === "ASSUMED";
}

/**
 * Requires every one of the 29 operational requirements (requirements-catalog.ts, the same
 * catalog the probe suite scores against) to have an answer a person gave before code generation
 * can proceed. What counts, in every mode: ANSWERED, ASSUMED, and older rows that have no status.
 * What never counts: SUGGESTED (written by the assistant, not by a person), UNKNOWN and CONFLICT.
 * Forms and the study questions screen both write responses; this gate is what turns that gathered
 * context into a stop/proceed decision -- code generation checks it, not the other way around.
 */
export function requirementsGate(responses: Array<{ requirementId: string; status?: string | null }>): { allowed: boolean; missing: RequirementId[] } {
  const answered = new Set(responses.filter((response) => countsAsAnswered(response.status)).map((response) => response.requirementId));
  const missing = REQUIREMENT_ORDER.filter((id) => !answered.has(id));
  return { allowed: missing.length === 0, missing };
}

export function pipelineExecutionGate(input: PipelineExecutionInput): { allowed: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!ethicsCleared(input.ethicsStatus, input.ethicsValidUntil)) missing.push("ethicsApproval");
  if (input.pipelineApprovalStatus !== "APPROVED") missing.push("approvedPipelineVersion");
  if (input.pipelineValidationStatus !== "PASSED") missing.push("passedPipelineValidation");
  if (input.readinessChecks.length === 0) missing.push("readySites");
  if (input.readinessChecks.some((check) => !siteSignedOff(check))) missing.push("allSitesReady");

  return { allowed: missing.length === 0, missing };
}

export type SiteReadinessSnapshot = {
  code: string;
  name: string;
  /** Latest readiness check for the site, or null when none has been recorded. */
  check: {
    dependenciesVerified?: boolean | null;
    policyAccepted?: boolean | null;
  } | null;
};

export type UnreadySite = { code: string; name: string; problems: string[] };

/** Sites with no recorded sign-off, with what is still open for each. Decided from the human fields, not the stored status. */
export function describeUnreadySites(sites: SiteReadinessSnapshot[]): UnreadySite[] {
  const unready: UnreadySite[] = [];
  for (const site of sites) {
    if (!site.check) {
      unready.push({ code: site.code, name: site.name, problems: ["no site sign-off has been recorded"] });
      continue;
    }
    if (siteSignedOff(site.check)) continue;
    const problems: string[] = [];
    if (!site.check.dependenciesVerified) problems.push("software checks not confirmed");
    if (!site.check.policyAccepted) problems.push("data-use policy not accepted");
    unready.push({ code: site.code, name: site.name, problems });
  }
  return unready;
}

const GATE_EXPLANATIONS: Record<string, string> = {
  ethicsApproval: "the ethics decision is not recorded as approved, or has expired (record it under Study setup)",
  approvedPipelineVersion: "the pipeline version is not approved (an authorised reviewer must approve it)",
  passedPipelineValidation: "the pipeline version has not passed its checks (publish it and wait for the checks to finish)",
  readySites: "no sites are selected (add at least one site and record its site sign-off)"
};

/** One human-readable sentence per unmet execution requirement; names unready sites and the fix. */
export function executionGateMessage(missing: string[], unreadySites: UnreadySite[] = []): string {
  const parts: string[] = [];
  for (const key of missing) {
    if (key === "allSitesReady") {
      if (unreadySites.length === 0) {
        parts.push("some sites have not signed off (open Sites and record the site sign-off for each)");
      } else {
        const detail = unreadySites.map((site) => `${site.name || site.code}: ${site.problems.join(", ")}`).join("; ");
        parts.push(
          `${unreadySites.length} ${unreadySites.length === 1 ? "site is" : "sites are"} not ready (${detail}). Ask each site operator to finish the open items in the site sign-off under Sites`
        );
      }
    } else {
      parts.push(GATE_EXPLANATIONS[key] ?? "a requirement is still open");
    }
  }
  return `Cannot start the run yet: ${parts.join("; ")}.`;
}

/** Plain sentence for one publish requirement; `detail` carries counts such as how many study questions are left. */
export function publishRequirementMessage(key: "ethicsApproval" | "studyQuestions" | "studySites", detail?: { remaining?: number }): string {
  if (key === "ethicsApproval") return "Record the ethics decision";
  if (key === "studySites") return "Add at least one site";
  const left = detail?.remaining;
  return typeof left === "number" ? `Answer the remaining study questions (${left} left)` : "Answer the remaining study questions";
}
