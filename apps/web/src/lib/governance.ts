import type { EthicsStatus, GovernanceStatus, PipelineVersionStatus, ReadinessStatus } from "@prisma/client";
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
};

type SiteReadiness = {
  status: ReadinessStatus;
};

type StudyActivationInput = ProtocolMetadata & {
  ethics?: EthicsRecord[];
  studySites?: unknown[];
  // When provided, every one of the 29 requirements must be answered before activation
  // (requirements are part of protocol definition, so they are gathered before the study goes live).
  requirementResponses?: Array<{ requirementId: string }>;
};

type PipelineExecutionInput = {
  ethicsStatus?: EthicsStatus | null;
  pipelineApprovalStatus?: PipelineVersionStatus | null;
  pipelineValidationStatus?: string | null;
  readinessChecks: SiteReadiness[];
};

export const REQUIRED_PROTOCOL_FIELDS: Array<keyof ProtocolMetadata> = [
  "title",
  "goal",
  "researchQuestion",
  "studyDesign",
  "clinicalUseCase",
  "population",
  "eligibilityCriteria",
  "dataModalities",
  "primaryOutcome",
  "primaryEndpointDetails",
  "analysisPlan",
  "dataHandlingPlan",
  "intendedUse"
];

function meaningfulProtocolText(value: unknown) {
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

export function ethicsCleared(status?: EthicsStatus | null): boolean {
  return status === "APPROVED" || status === "NOT_REQUIRED";
}

export function activationGate(study: StudyActivationInput): { allowed: boolean; missing: string[]; status: GovernanceStatus } {
  const missing = missingProtocolFields(study);
  if (!study.studySites?.length) missing.push("studySites");

  const ethicsStatus = latestEthicsStatus(study.ethics);
  if (!ethicsCleared(ethicsStatus)) missing.push("ethicsApproval");

  if (study.requirementResponses) {
    const requirements = requirementsGate(study.requirementResponses);
    if (!requirements.allowed) missing.push(`requirements (${REQUIREMENT_ORDER.length - requirements.missing.length}/${REQUIREMENT_ORDER.length} answered)`);
  }

  if (missing.length > 0) {
    return { allowed: false, missing, status: "INCOMPLETE" };
  }

  return { allowed: true, missing: [], status: "APPROVED" };
}

/**
 * Requires every one of the 29 operational requirements (requirements-catalog.ts, the same
 * catalog the probe suite scores against) to have a recorded response before code generation
 * can proceed. Forms and the requirements chat window both write responses; this gate is what
 * turns that gathered context into a stop/proceed decision -- code generation checks it, not
 * the other way around.
 */
export function requirementsGate(responses: Array<{ requirementId: string }>): { allowed: boolean; missing: RequirementId[] } {
  const answered = new Set(responses.map((response) => response.requirementId));
  const missing = REQUIREMENT_ORDER.filter((id) => !answered.has(id));
  return { allowed: missing.length === 0, missing };
}

export function pipelineExecutionGate(input: PipelineExecutionInput): { allowed: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!ethicsCleared(input.ethicsStatus)) missing.push("ethicsApproval");
  if (input.pipelineApprovalStatus !== "APPROVED") missing.push("approvedPipelineVersion");
  if (input.pipelineValidationStatus !== "PASSED") missing.push("passedPipelineValidation");
  if (input.readinessChecks.length === 0) missing.push("readySites");
  if (input.readinessChecks.some((check) => check.status !== "PASSED")) missing.push("allSitesReady");

  return { allowed: missing.length === 0, missing };
}

export type SiteReadinessSnapshot = {
  code: string;
  name: string;
  /** Latest readiness check for the site, or null when none has been recorded. */
  check: {
    status: ReadinessStatus;
    connectivityVerified?: boolean | null;
    kitInstalled?: boolean | null;
    dependenciesVerified?: boolean | null;
    policyAccepted?: boolean | null;
  } | null;
};

export type UnreadySite = { code: string; name: string; problems: string[] };

/** Sites whose latest readiness check is missing or not PASSED, with what is still open for each. */
export function describeUnreadySites(sites: SiteReadinessSnapshot[]): UnreadySite[] {
  const unready: UnreadySite[] = [];
  for (const site of sites) {
    if (!site.check) {
      unready.push({ code: site.code, name: site.name, problems: ["no readiness check has been recorded"] });
      continue;
    }
    if (site.check.status === "PASSED") continue;
    const problems: string[] = [];
    if (!site.check.kitInstalled) problems.push("site kit not confirmed installed");
    if (!site.check.connectivityVerified) problems.push("connectivity not verified");
    if (!site.check.dependenciesVerified) problems.push("dependencies not verified");
    if (!site.check.policyAccepted) problems.push("data-use policy not accepted");
    if (problems.length === 0) problems.push(`readiness status is ${site.check.status}, not PASSED`);
    unready.push({ code: site.code, name: site.name, problems });
  }
  return unready;
}

const GATE_EXPLANATIONS: Record<string, string> = {
  ethicsApproval: "ethics approval is not recorded as approved (add or update it under the study's Governance)",
  approvedPipelineVersion: "the pipeline version is not approved (an authorised reviewer must approve it)",
  passedPipelineValidation: "pipeline validation has not passed (publish the version and wait for its checks)",
  readySites: "no participating sites are selected (add at least one site and record its readiness)"
};

/** One human-readable sentence per unmet execution requirement; names unready sites and the fix. */
export function executionGateMessage(missing: string[], unreadySites: UnreadySite[] = []): string {
  const parts: string[] = [];
  for (const key of missing) {
    if (key === "allSitesReady") {
      if (unreadySites.length === 0) {
        parts.push("some sites have not passed their readiness check (open Sites and record readiness for each)");
      } else {
        const detail = unreadySites.map((site) => `${site.name} (${site.code}): ${site.problems.join(", ")}`).join("; ");
        parts.push(
          `${unreadySites.length} site(s) are not ready: ${detail}. Ask each site operator to finish onboarding, then record a PASSED readiness check for the site under Sites`
        );
      }
    } else {
      parts.push(GATE_EXPLANATIONS[key] ?? key);
    }
  }
  return `Cannot start the run yet: ${parts.join("; ")}.`;
}
