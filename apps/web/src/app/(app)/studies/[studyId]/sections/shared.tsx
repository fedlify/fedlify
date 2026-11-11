"use client";

import { message } from "antd";
import { useCallback, useState, type ReactNode } from "react";
import { normalizeRichTextValue, richTextHasText } from "@/components/RichTextEditor";
import { missingProtocolFields as missingCoreProtocolFields } from "@/lib/governance";
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
  if (!value || typeof value !== "string") return "Not recorded";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function displayEnum(value: unknown, fallback = "Not set") {
  if (!value || typeof value !== "string") return fallback;
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Pdf", "PDF");
}

const STUDY_PROTOCOL_FIELD_LABELS: Record<string, string> = {
  title: "Study title",
  goal: "Primary objective",
  researchQuestion: "Research question",
  studyDesign: "Type of study",
  clinicalUseCase: "Clinical use case",
  population: "Population",
  eligibilityCriteria: "Eligibility criteria",
  dataModalities: "Data modalities",
  primaryOutcome: "Primary endpoint",
  primaryEndpointDetails: "Endpoint details",
  analysisPlan: "Analysis plan",
  dataHandlingPlan: "Data handling plan",
  intendedUse: "Intended use"
};

const RICH_STUDY_DESIGN_FIELDS = [
  "description",
  "goal",
  "researchQuestion",
  "hypothesis",
  "secondaryObjectives",
  "studyDesign",
  "eligibilityCriteria",
  "primaryEndpointDetails",
  "secondaryOutcomes",
  "sampleSizeRationale",
  "analysisPlan",
  "dataHandlingPlan",
  "humanAiWorkflow",
  "fairnessPlan",
  "disseminationPlan"
];

export function normalizeStudyDesignPayload(values: Record<string, unknown>) {
  return RICH_STUDY_DESIGN_FIELDS.reduce(
    (payload, field) => ({
      ...payload,
      [field]: normalizeRichTextValue(values[field])
    }),
    { ...values }
  );
}

function readableList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function summarizeMissingLabels(items: string[], maxItems = 3) {
  if (items.length <= maxItems) return readableList(items);
  return `${readableList(items.slice(0, maxItems))}, and ${items.length - maxItems} more`;
}

export const REQUIRED_RICH_TEXT_RULE = {
  validator: (_: unknown, value: unknown) =>
    richTextHasText(value) ? Promise.resolve() : Promise.reject(new Error("This field is required."))
};

export function GovernanceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fedlify-governance-section">
      <div className="fedlify-governance-section-title">{title}</div>
      {children}
    </section>
  );
}

export function latestEthicsStatus(study?: StudyDetail | null) {
  return study?.ethics?.[0]?.status;
}

export function ethicsGatePassed(study?: StudyDetail | null) {
  const latest = latestEthicsStatus(study);
  return latest === "APPROVED" || latest === "NOT_REQUIRED";
}

/** What is still missing before the study can be activated. */
export function protocolStatus(study: StudyDetail) {
  const missingProtocolFields = missingCoreProtocolFields(study);
  const missingProtocolFieldLabels = missingProtocolFields.map((field) => STUDY_PROTOCOL_FIELD_LABELS[field] ?? displayEnum(field));
  const protocolMetadataReady = missingProtocolFields.length === 0;
  const ethicsReady = ethicsGatePassed(study);
  const siteCount = study.studySites?.length ?? study.sites.length;
  const hasSite = siteCount > 0;
  const requirementsAnswered = study.requirementResponses?.length ?? 0;
  const requirementsReady = requirementsAnswered >= REQUIREMENTS_TOTAL;
  const missingActivationItems = [
    ...missingProtocolFieldLabels,
    ethicsReady ? null : "Ethics decision",
    hasSite ? null : "Site",
    requirementsReady ? null : `Study questions (${requirementsAnswered}/${REQUIREMENTS_TOTAL} answered)`
  ].filter(Boolean) as string[];
  return {
    missingProtocolFieldLabels,
    missingActivationItems,
    protocolMetadataReady,
    ethicsReady,
    siteCount,
    hasSite,
    requirementsAnswered,
    requirementsReady,
    activationReady: protocolMetadataReady && ethicsReady && hasSite && requirementsReady
  };
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
