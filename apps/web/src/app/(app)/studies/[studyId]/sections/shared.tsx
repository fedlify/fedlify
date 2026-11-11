"use client";

import { message } from "antd";
import { useCallback, useState } from "react";
import { CLINICAL_USE_CASE_OPTIONS, governanceOptionLabel, INTENDED_USE_OPTIONS } from "@/lib/governance-options";
import { formatDate as formatDateValue } from "@/lib/format";
import { countsAsAnswered, ethicsCleared, meaningfulProtocolText, missingProtocolFields as missingCoreProtocolFields } from "@/lib/governance";
import { REQUIREMENT_ORDER } from "@/lib/requirements-catalog";

/** Types, wording helpers and the request hook shared by the study page and its sections. */

export const REQUIREMENTS_TOTAL = REQUIREMENT_ORDER.length;

export type EntityRecord = Record<string, any>;

export type StudyDetail = {
  id: string;
  title: string;
  description?: string;
  goal?: string;
  researchQuestion?: string;
  hypothesis?: string;
  secondaryObjectives?: string;
  clinicalUseCase?: string;
  studyDesign?: string;
  population?: string;
  eligibilityCriteria?: string;
  dataModalities?: string;
  primaryOutcome?: string;
  primaryEndpointDetails?: string;
  secondaryOutcomes?: string;
  sampleSizeRationale?: string;
  analysisPlan?: string;
  dataHandlingPlan?: string;
  humanAiWorkflow?: string;
  fairnessPlan?: string;
  disseminationPlan?: string;
  riskLevel?: string;
  intendedUse?: string;
  governanceStatus?: string;
  status: string;
  organization: { id: string; name: string };
  members: Array<EntityRecord & { id: string; role: string; user: { id?: string; name?: string; email?: string } }>;
  invitations: EntityRecord[];
  ethics: EntityRecord[];
  documents: EntityRecord[];
  requirementResponses?: EntityRecord[];
  sites: Array<EntityRecord & { heartbeats?: EntityRecord[]; studySite?: EntityRecord }>;
  studySites: EntityRecord[];
};

export function text(value: unknown, fallback = "Not set") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function status(value: unknown, fallback = "PENDING") {
  return typeof value === "string" && value ? value : fallback;
}

export function formatDate(value: unknown) {
  return formatDateValue(typeof value === "string" ? value : null, "Not recorded");
}

export function displayEnum(value: unknown, fallback = "Not set") {
  if (!value || typeof value !== "string") return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Pdf", "PDF");
}

/** Study details from before the simplification. They are kept and shown read-only; the form no longer edits them. */
export const EARLIER_DESIGN_NOTES: Array<{ field: keyof StudyDetail; label: string }> = [
  { field: "hypothesis", label: "Hypothesis" },
  { field: "secondaryObjectives", label: "Secondary objectives" },
  { field: "studyDesign", label: "Type of study" },
  { field: "eligibilityCriteria", label: "Eligibility criteria" },
  { field: "primaryEndpointDetails", label: "Endpoint details" },
  { field: "secondaryOutcomes", label: "Secondary outcomes" },
  { field: "sampleSizeRationale", label: "Sample size / rationale" },
  { field: "analysisPlan", label: "Analysis plan" },
  { field: "dataHandlingPlan", label: "Data handling plan" },
  { field: "humanAiWorkflow", label: "How people and the AI work together" },
  { field: "fairnessPlan", label: "Fairness / subgroup plan" },
  { field: "disseminationPlan", label: "Dissemination plan" }
];

/** Stored text without markup (older studies saved rich text); empty string when there is nothing to show. */
export function plainText(value: unknown): string {
  return meaningfulProtocolText(value);
}

/** Intended use is one field now. Studies from before kept a separate clinical use case; show both when only the old one exists. */
export function intendedUseText(study: Pick<StudyDetail, "intendedUse" | "clinicalUseCase">): string {
  // Older studies stored an option value ("RESEARCH_ONLY"); show its label.
  const intended = plainText(governanceOptionLabel(INTENDED_USE_OPTIONS, plainText(study.intendedUse)));
  const clinical = plainText(governanceOptionLabel(CLINICAL_USE_CASE_OPTIONS, plainText(study.clinicalUseCase)));
  if (intended && clinical && !intended.toLowerCase().includes(clinical.toLowerCase())) return `${intended}. ${clinical}`;
  return intended || clinical;
}

export function ethicsGatePassed(study?: StudyDetail | null) {
  const latest = study?.ethics?.[0];
  return ethicsCleared(latest?.status, latest?.validUntil);
}

/** What is still missing before the study can start. Uses the same rule and counter as the server (lib/governance.ts). */
export function protocolStatus(study: StudyDetail) {
  const missingFields = missingCoreProtocolFields(study);
  const detailsReady = missingFields.length === 0;
  const ethicsReady = ethicsGatePassed(study);
  const siteCount = study.studySites?.length ?? study.sites.length;
  const hasSite = siteCount > 0;
  const requirementsAnswered = new Set((study.requirementResponses ?? []).filter((row) => countsAsAnswered(row.status)).map((row) => row.requirementId)).size;
  const requirementsReady = requirementsAnswered >= REQUIREMENTS_TOTAL;
  return { missingFields, detailsReady, ethicsReady, siteCount, hasSite, requirementsAnswered, requirementsReady };
}

/**
 * One POST or PATCH with shared submitting/error state and a toast. `onDone` runs after a success (usually a reload).
 * Render `contextHolder` once next to the component that uses it.
 */
export function useStudyRequest(onDone: () => void | Promise<void>) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const send = useCallback(
    async (method: "POST" | "PATCH", path: string, values: unknown, success: string) => {
      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values)
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "The request could not be completed.");
        messageApi.success(success);
        await onDone();
        return body ?? {};
      } catch (err) {
        const next = err instanceof Error ? err.message : "The request could not be completed.";
        setError(next);
        messageApi.error(next);
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [messageApi, onDone]
  );

  return {
    submitting,
    error,
    setError,
    messageApi,
    contextHolder,
    post: (path: string, values: unknown, success: string) => send("POST", path, values, success),
    patch: (path: string, values: unknown, success: string) => send("PATCH", path, values, success)
  };
}
