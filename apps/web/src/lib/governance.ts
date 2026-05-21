import type { EthicsStatus, GovernanceStatus, PipelineVersionStatus, ReadinessStatus } from "@prisma/client";

type ProtocolMetadata = {
  title?: string | null;
  goal?: string | null;
  researchQuestion?: string | null;
  clinicalUseCase?: string | null;
  population?: string | null;
  dataModalities?: string | null;
  primaryOutcome?: string | null;
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
  "clinicalUseCase",
  "population",
  "dataModalities",
  "primaryOutcome",
  "intendedUse"
];

export function missingProtocolFields(study: ProtocolMetadata): string[] {
  return REQUIRED_PROTOCOL_FIELDS.filter((field) => {
    const value = study[field];
    return typeof value !== "string" || value.trim().length === 0;
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

  if (missing.length > 0) {
    return { allowed: false, missing, status: "INCOMPLETE" };
  }

  return { allowed: true, missing: [], status: "APPROVED" };
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
