import { z } from "zod";
import { hmacSha256, sha256 } from "@/lib/crypto";

export const CONTROL_POLICY_VERSION = "fedlify-v3.0";
export const SIGNING_KEY_ID = "fedlify-control-plane-v1";

export const controlStateSchema = z.enum([
  "INTAKE",
  "CLASSIFIED",
  "QUARANTINED",
  "POLICY_AUTHORIZED",
  "WORK_ITEM_SIGNED",
  "EVIDENCE_ASSEMBLED",
  "WORKER_COMPLETED",
  "DETERMINISTIC_VERIFIED",
  "SEMANTIC_VERIFIED",
  "HUMAN_APPROVED",
  "EXPORTED",
  "STOPPED"
]);

export type ControlState = z.infer<typeof controlStateSchema>;

export const allowedTransitions: Readonly<Record<ControlState, readonly ControlState[]>> = {
  INTAKE: ["CLASSIFIED", "QUARANTINED", "STOPPED"],
  CLASSIFIED: ["POLICY_AUTHORIZED", "QUARANTINED", "STOPPED"],
  QUARANTINED: ["CLASSIFIED", "STOPPED"],
  POLICY_AUTHORIZED: ["WORK_ITEM_SIGNED", "STOPPED"],
  WORK_ITEM_SIGNED: ["EVIDENCE_ASSEMBLED", "STOPPED"],
  EVIDENCE_ASSEMBLED: ["WORKER_COMPLETED", "STOPPED"],
  WORKER_COMPLETED: ["DETERMINISTIC_VERIFIED", "STOPPED"],
  DETERMINISTIC_VERIFIED: ["SEMANTIC_VERIFIED", "STOPPED"],
  SEMANTIC_VERIFIED: ["HUMAN_APPROVED", "STOPPED"],
  HUMAN_APPROVED: ["EXPORTED", "STOPPED"],
  EXPORTED: [],
  STOPPED: []
};

export const mutatingHeadersSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  expectedVersion: z.coerce.number().int().positive()
});

export const createWorkItemSchema = z.object({
  skillContractId: z.string().min(1),
  purpose: z.string().trim().min(3).max(4000),
  input: z.unknown(),
  evidenceIds: z.array(z.string().min(1)).max(100).default([]),
  allowedTools: z.array(z.string().min(1)).max(30).default([]),
  tokenBudget: z.number().int().positive().max(2_000_000).optional(),
  timeBudgetSeconds: z.number().int().positive().max(86_400).optional(),
  expiresAt: z.coerce.date().optional()
});

export const evidenceIntakeSchema = z.object({
  sourceType: z.string().trim().min(1).max(100),
  sourceLocator: z.string().trim().min(1).max(2000),
  sourceVersion: z.string().trim().max(200).optional(),
  freshnessExpiresAt: z.coerce.date().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  filename: z.string().trim().max(500).optional(),
  contentType: z.string().trim().max(200).optional(),
  containsSensitive: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function controlSigningSecret(): string {
  const secret = process.env.FEDLIFY_CONTROL_SIGNING_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret === "replace-with-32-bytes") {
    throw new Error("FEDLIFY_CONTROL_SIGNING_SECRET must be configured with a non-default secret.");
  }
  return secret;
}

export function signControlPayload(value: unknown): string {
  return hmacSha256(controlSigningSecret(), canonicalJson(value));
}

export function assertTransition(from: ControlState, to: ControlState): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid control-plane transition: ${from} -> ${to}.`);
  }
}

export function mutationHeaders(headers: Headers) {
  return mutatingHeadersSchema.parse({
    idempotencyKey: headers.get("idempotency-key"),
    expectedVersion: headers.get("if-match-version")
  });
}

export type EvidenceDisposition = {
  classification: "CURATED" | "UNTRUSTED" | "SENSITIVE" | "QUARANTINED" | "REJECTED";
  reasonCodes: string[];
};

const blockedExtensions = [".parquet", ".dcm", ".dicom", ".nii", ".h5", ".hdf5"];

export function classifyEvidence(input: z.infer<typeof evidenceIntakeSchema>): EvidenceDisposition {
  const filename = input.filename?.toLowerCase() ?? "";
  const content = canonicalJson({ sourceLocator: input.sourceLocator, metadata: input.metadata ?? {} }).toLowerCase();
  const inspectAtIntake = input.sourceType !== "SIGNED_ARTIFACT_CANDIDATE";
  if (/(encrypted archive|cannot be inspected|uninspectable|encryption:\s*aes|contents:\s*unknown)/i.test(content)) {
    return { classification: "REJECTED", reasonCodes: ["UNINSPECTABLE_INPUT"] };
  }
  const rowLevelTable = /\.(csv|tsv)$/.test(filename) && /(patientunitstayid|patienthealthsystemstayid|uniquepid|patient_id|subject_id|record_id|encounter_id)/i.test(content);
  const rawClinical = blockedExtensions.some((extension) => filename.endsWith(extension)) || rowLevelTable ||
    /(patientunitstayid|patienthealthsystemstayid|uniquepid|subject_id|patient_id|medical record number|\bmrn\b)/i.test(content);
  const credential = /(-----begin (rsa |openssh )?private key-----|bearer\s+[a-z0-9._-]{12,}|password\s*[:=]\s*[^\s,}]+|api[_ -]?key\s*[:=]\s*[^\s,}]+|model_write_token\s*=)/i.test(content);
  const activeContent = /(<script\b|#!\/bin\/(sh|bash)|start_nvflare_job|<iframe\b)/i.test(content);
  const directInjection = /(ignore (all |the )?(previous|system|platform) (instructions|rules)|connect to the local ehr|reviewer-only note to ai|change allowed_tools|system message:.{0,80}(ignore|override))/is.test(content);
  const modelUpdate = /(file_class:\s*training-time model update|serialized gradient\/update|tensor payload)/i.test(content);
  if (input.containsSensitive || (inspectAtIntake && (rawClinical || credential || activeContent || directInjection || modelUpdate))) {
    return {
      classification: "QUARANTINED",
      reasonCodes: [
        input.containsSensitive || credential ? "SENSITIVE_CONTENT" :
          rawClinical ? "RAW_CLINICAL_DATA" : activeContent ? "ACTIVE_CONTENT" :
            directInjection ? "PROMPT_INJECTION" : "MODEL_UPDATE_ARTIFACT"
      ]
    };
  }
  if (!input.sourceVersion) {
    const unresolvedConflict = /(no approved deviation record|no hierarchy or conflict-resolution authority)/i.test(content);
    return { classification: "UNTRUSTED", reasonCodes: [unresolvedConflict ? "UNRESOLVED_CONFLICT" : "UNVERSIONED_SOURCE"] };
  }
  if (input.freshnessExpiresAt && input.freshnessExpiresAt <= new Date()) {
    return { classification: "UNTRUSTED", reasonCodes: ["STALE_EVIDENCE"] };
  }
  return { classification: "CURATED", reasonCodes: [] };
}

const contentBearingMetadataKeys = /^(?:content|fixturecontent|rawcontent|prompt|payload|rows|records|patientdata)$/i;

/** Evidence ledgers retain descriptors and hashes, never submitted content or prompts. */
export function metadataForPersistence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(metadataForPersistence);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    contentBearingMetadataKeys.test(key)
      ? { redacted: true, contentHash: contentHash(item) }
      : metadataForPersistence(item)
  ]));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\b(AKI[AI][A-Z0-9]{12,})\b/g, "[REDACTED_AWS_KEY]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:password|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]");
}

export function hasCredentialMaterial(value: unknown): boolean {
  const serialized = canonicalJson(value);
  return redactSecrets(serialized) !== serialized;
}
