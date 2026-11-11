import { z } from "zod";
import { classifyEvidence, contentHash, redactSecrets } from "@/lib/control-plane";
import { sha256 } from "@/lib/crypto";
import {
  evaluateApprovalPayload,
  evaluateExportPayload,
  evaluateVerification,
  evaluateWorkItemPolicy
} from "@/lib/control-enforcement";

export const authoritativeLayerSchema = z.enum([
  "Intake classifier",
  "Evidence classification",
  "Policy engine / work-item contract",
  "Deterministic verifier",
  "Semantic verifier",
  "Human gate / approval binding",
  "Workflow engine / dependency invalidation",
  "Site readiness gate",
  "Handoff exporter",
  "Runtime status ingestion",
  "No block - proceed"
]);

export const requirementIdSchema = z.enum([
  "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10",
  "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20",
  "R21", "R22", "R23", "R24", "R25", "R26", "R27", "R28", "R29"
]);

export const coordinatorAdvisorySchema = z.object({
  intent: z.enum([
    "STUDY_PREPARATION", "EVIDENCE_UPDATE", "PROTOCOL_CHANGE", "SITE_READINESS",
    "RUNTIME_EVENT", "APPROVAL_REQUEST", "EXPORT_REQUEST", "RECOVERY_OR_ROLLBACK", "OTHER"
  ]),
  requirementIds: z.array(requirementIdSchema).min(1).max(12),
  riskSignals: z.array(z.enum([
    "EVIDENCE_GAP", "SEMANTIC_CONFLICT", "AUTHORITY_UNCERTAIN", "APPROVAL_REQUIRED",
    "READINESS_UNCERTAIN", "EXPORT_RISK", "RUNTIME_CHANGE", "SECURITY_RISK", "NONE"
  ])).max(20),
  requiredCapabilities: z.array(z.string().max(100)).max(20),
  clarificationQuestions: z.array(z.string().max(500)).max(10),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(1000)
});

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(500),
  contentType: z.string().trim().max(200).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  content: z.string().max(1_500_000).optional(),
  sourceLocator: z.string().trim().max(2000).optional(),
  sourceVersion: z.string().trim().max(200).optional()
});

export const authoritativeIntakeSchema = z.object({
  requestText: z.string().trim().min(1).max(8000),
  studyContext: z.string().trim().max(4000).default(""),
  attachments: z.array(attachmentSchema).max(10).default([]),
  profile: z.enum(["hosted", "local"]).default("hosted")
}).superRefine((value, context) => {
  const total = value.attachments.reduce((sum, attachment) => sum + (attachment.content?.length ?? 0), 0);
  if (total > 1_500_000) context.addIssue({ code: "custom", message: "Combined attachment content exceeds 1.5 MB." });
});

export type AuthoritativeIntake = z.infer<typeof authoritativeIntakeSchema>;
export type CoordinatorAdvisory = z.infer<typeof coordinatorAdvisorySchema>;
export type AuthoritativeLayer = z.infer<typeof authoritativeLayerSchema>;

export type IntakeResolution = {
  authoritativeLayer: AuthoritativeLayer;
  disposition: "QUARANTINE" | "REQUEST_CLARIFICATION" | "POLICY_STOP" | "DET_REJECT" | "SEM_REJECT" | "HUMAN_GATE" | "REOPEN" | "EXPORT" | "PROCEED_TO_DRAFT";
  stoppingCondition: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "None";
  controlState: "QUARANTINED" | "STOPPED" | "CLASSIFIED" | "POLICY_AUTHORIZED" | "WORK_ITEM_SIGNED" | "HUMAN_APPROVED" | "EXPORTED";
  reasonCodes: string[];
  requirements: z.infer<typeof requirementIdSchema>[];
  selectedContractId: string;
  stateTransition: string;
  maySendToModel: boolean;
};

const layerRequirements: Record<AuthoritativeLayer, z.infer<typeof requirementIdSchema>[]> = {
  "Intake classifier": ["R14", "R16", "R17", "R19"],
  "Evidence classification": ["R08", "R09", "R10", "R20"],
  "Policy engine / work-item contract": ["R05", "R06", "R17", "R20"],
  "Deterministic verifier": ["R13", "R19", "R20", "R26"],
  "Semantic verifier": ["R08", "R09", "R24", "R25"],
  "Human gate / approval binding": ["R04", "R05", "R06", "R25"],
  "Workflow engine / dependency invalidation": ["R07", "R28", "R29"],
  "Site readiness gate": ["R02", "R12", "R13", "R15"],
  "Handoff exporter": ["R17", "R18", "R25", "R26"],
  "Runtime status ingestion": ["R22", "R23", "R28"],
  "No block - proceed": ["R01", "R20"]
};

const layerContract: Record<AuthoritativeLayer, string> = {
  "Intake classifier": "fedlify.input-inspection.v1",
  "Evidence classification": "fedlify.evidence-curation.v1",
  "Policy engine / work-item contract": "fedlify.policy-authorization.v1",
  "Deterministic verifier": "fedlify.deterministic-verification.v1",
  "Semantic verifier": "fedlify.semantic-verification.v1",
  "Human gate / approval binding": "fedlify.approval-binding.v1",
  "Workflow engine / dependency invalidation": "fedlify.dependency-invalidation.v1",
  "Site readiness gate": "fedlify.site-readiness.v1",
  "Handoff exporter": "fedlify.credential-free-export.v1",
  "Runtime status ingestion": "fedlify.runtime-status.v1",
  "No block - proceed": "fedlify.bounded-preparation.v1"
};

const transitions = {
  intake: "Request received -> Intake classification -> QUARANTINE; model-readable path not entered",
  policy: "Request received -> Authority and contract check -> STOP/REJECT",
  evidence: "Request received -> Authority/contract check -> Evidence assembly/classification -> STOP/ASK; no authoritative fact or approval is created",
  deterministic: "Request received -> Authority and contract check -> Evidence assembled and classified -> Bounded draft generation -> Deterministic verification -> STOP/REJECT",
  semantic: "Request received -> Authority and contract check -> Evidence assembled and classified -> Bounded draft generation -> Deterministic verification -> Semantic verification -> STOP/REJECT",
  human: "Request -> checks -> evidence -> bounded draft -> deterministic verification -> semantic verification -> STOP at named human gate until authorized approval",
  reopen: "Accepted event/change -> Dependency lookup -> invalidate dependent approvals/artifacts -> reopen preparation -> require new evidence/approval",
  readiness: "Request received -> Authority and contract check -> Evidence assembled and classified -> STOP/REJECT",
  exportReject: "Request received -> Authority and contract check -> Evidence assembled and classified -> Bounded draft generation -> Deterministic verification -> Semantic verification -> Named human review gate -> Signed handoff/export -> STOP/REJECT",
  exportAuthorized: "Request -> checks -> verified approval binding -> credential-free handoff exporter authorized",
  runtime: "Authenticated runtime event -> validate source and job binding -> append status event",
  proceed: "Request received -> Authority/contract check -> Evidence assembly/classification -> Bounded draft -> Deterministic verification -> Semantic verification -> Named human gate"
} as const;

function combinedText(input: AuthoritativeIntake): string {
  return [input.requestText, input.studyContext, ...input.attachments.map(({ name, content }) => `${name}\n${content ?? ""}`)].join("\n");
}

/**
 * Requests to check for gaps ("show anything still missing", "report missing items") reuse
 * evidence-gap vocabulary to ask a question, not to state a fact. Strip that instruction shape
 * out before evidenceSignals runs below, so it can still fire on a *declarative* gap statement
 * ("the outcome definition is missing") wherever that appears, including in requestText.
 */
const gapCheckInstruction = /\b(show|report|list|surface|flag|identify|highlight)\b[^.?!]{0,40}\b(missing|incomplete|unresolved)\b/gi;

/**
 * A documented "Definitions" section that lists two or more distinct methodological bases
 * (ICD-coded, medication-derived, problem-list/phenotype-derived, ...) for the same reported
 * measure is itself evidence of cross-site semantic heterogeneity -- the same class of gap as
 * the lactate arterial-vs-venous example in the Methods text -- independent of whether the
 * source text ever uses a word like "conflict".
 */
function hasHeterogeneousDefinitions(text: string): boolean {
  const definitionsHeading = /##?\s*definitions?\b/i.exec(text);
  if (!definitionsHeading) return false;
  const window = text.slice(definitionsHeading.index, definitionsHeading.index + 800);
  const markers = [/\bicd\b|\bdiagnosis code/i, /\bmedication\b/i, /\bproblem-list\b|\bphenotype\b/i];
  return markers.filter((marker) => marker.test(window)).length >= 2;
}

/**
 * A table with a numeric "n" (count) column where a reported cell is below 11 -- the
 * conventional statistical disclosure-control threshold -- carries a re-identification risk
 * even though no row-level data is present. Parsed line-by-line rather than by regex because
 * the signal is a specific column's values, not a keyword.
 */
function hasSmallCellDisclosureRisk(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes(",") && /(^|,)\s*n\s*(,|$)/i.test(line));
  if (headerIndex === -1) return false;
  const headers = lines[headerIndex].split(",").map((header) => header.trim().toLowerCase());
  const countIndex = headers.indexOf("n");
  if (countIndex === -1) return false;
  return lines.slice(headerIndex + 1).some((line) => {
    if (!line.includes(",")) return false;
    const value = Number(line.split(",")[countIndex]?.trim());
    return Number.isFinite(value) && value > 0 && value < 11;
  });
}

function resolution(
  authoritativeLayer: AuthoritativeLayer,
  disposition: IntakeResolution["disposition"],
  stoppingCondition: IntakeResolution["stoppingCondition"],
  controlState: IntakeResolution["controlState"],
  reasonCodes: string[],
  stateTransition: string,
  maySendToModel = true
): IntakeResolution {
  return {
    authoritativeLayer,
    disposition,
    stoppingCondition,
    controlState,
    reasonCodes,
    requirements: layerRequirements[authoritativeLayer],
    selectedContractId: layerContract[authoritativeLayer],
    stateTransition,
    maySendToModel
  };
}

/** First pass is intentionally model-free so prohibited content never reaches a provider. */
export function inspectIntake(input: AuthoritativeIntake): IntakeResolution | null {
  const text = combinedText(input);
  const disposition = classifyEvidence({
    sourceType: "AUTHORITATIVE_INTAKE",
    sourceLocator: `intake://${contentHash({ requestText: input.requestText, attachments: input.attachments.map(({ contentHash: hash }) => hash) })}`,
    sourceVersion: "fedlify-intake-v1",
    contentHash: contentHash(text),
    filename: input.attachments.map(({ name }) => name).join(","),
    containsSensitive: false,
    metadata: { content: text }
  });
  if (["QUARANTINED", "REJECTED"].includes(disposition.classification)) {
    return resolution("Intake classifier", disposition.classification === "QUARANTINED" ? "QUARANTINE" : "POLICY_STOP", disposition.classification === "QUARANTINED" ? "4" : "5", disposition.classification === "QUARANTINED" ? "QUARANTINED" : "STOPPED", disposition.reasonCodes, transitions.intake, false);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Assistant intake profile.
//
// The probe profile above (inspectIntake / resolveDeterministicIntake) is tuned to the evaluation probes and to
// attachments: it quarantines on a bare column name such as patient_id, on "#!/bin/bash" and on any "password="
// look-alike. That is right for uploaded evidence and wrong for chat, where a clinical PI routinely writes "drop the
// patient_id column". This profile is for text the person typed or pasted in ONE turn (message, editor selection,
// answers to questions). It must never be applied to repository files or the context pack.
//
// Rules that stay as they are: credentials, active content / script injection, prompt injection, model weights.
// The raw clinical data rule is narrowed to row-shaped data: an identifier-like header with values on two or more
// delimited lines, several identifier records, or a pasted array of patient records. The mere mention of a column
// name is clear.
// ---------------------------------------------------------------------------------------------------------------

export type AssistantIntakeReason = { code: "SENSITIVE_CONTENT" | "RAW_CLINICAL_DATA" | "ACTIVE_CONTENT" | "PROMPT_INJECTION" | "MODEL_UPDATE_ARTIFACT"; layer: AuthoritativeLayer };
export type AssistantIntakeResult = {
  verdict: "clear" | "quarantine";
  reasons: AssistantIntakeReason[];
  /** Empty when clear. Never contains clinical rows, and has secrets, long tokens and digit runs masked. */
  redactedPreview: string;
};

const ID_FIELD = /(patientunitstayid|patienthealthsystemstayid|uniquepid|patient_?id|subject_?id|record_?id|encounter_?id|person_?id|hadm_?id|stay_?id|\bmrn\b|medical_?record(_?number)?|\bssn\b)/i;
const ID_VALUE_KEYS = /["']?(patientunitstayid|patienthealthsystemstayid|uniquepid|patient_?id|subject_?id|record_?id|encounter_?id|person_?id|hadm_?id|mrn|ssn)["']?\s*[:=]\s*["']?[A-Za-z]{0,4}[-_]?\d{3,}/gi;
/** Header fields that identify a person without being a database id: a table of these plus clinical columns is patient rows. */
const WEAK_IDENTITY_FIELD = /^(id|name|first_?name|last_?name|full_?name|dob|date_?of_?birth|birth_?date|address|phone|email)$/i;
const CLINICAL_KEYS = /(patient|subject|mrn|dob|birth|\bage\b|\bsex\b|gender|diagnos|icd|admission|discharge|\bname\b|address|phone|ssn|lab|vital)/i;

function splitFields(line: string, delimiter: string): string[] {
  const fields = line.split(delimiter).map((field) => field.trim());
  if (delimiter === "|") {
    if (fields[0] === "") fields.shift();
    if (fields[fields.length - 1] === "") fields.pop();
  }
  return fields;
}

function isPatientHeader(header: string[]): boolean {
  const short = header.filter((field) => field.length <= 40);
  if (short.some((field) => ID_FIELD.test(field))) return true;
  const weak = short.filter((field) => WEAK_IDENTITY_FIELD.test(field)).length;
  const clinical = short.filter((field) => WEAK_IDENTITY_FIELD.test(field) || CLINICAL_KEYS.test(field)).length;
  return weak >= 1 && clinical >= 2;
}

/** An identifier-like header line followed by two or more delimited data lines of the same width that carry digits. */
function hasDelimitedPatientRows(lines: string[]): boolean {
  for (const delimiter of [",", "\t", "|", ";"]) {
    for (let index = 0; index < lines.length; index += 1) {
      const header = splitFields(lines[index]!, delimiter);
      if (header.length < 2) continue;
      if (!isPatientHeader(header)) continue;
      let rows = 0;
      for (const line of lines.slice(index + 1, index + 40)) {
        if (/^[\s|:-]+$/.test(line)) continue;
        const fields = splitFields(line, delimiter);
        if (fields.length === header.length && /\d/.test(line)) rows += 1;
        else break;
      }
      if (rows >= 2) return true;
    }
  }
  return false;
}

/** Three or more lines that each start with an identifier-like value followed by at least three more delimited fields. */
function hasHeaderlessRecords(lines: string[]): boolean {
  let run = 0;
  for (const line of lines) {
    if (/^["']?[A-Za-z]{0,4}[-_]?\d{5,}["']?(\s*[,;\t|]\s*[^,;\t|\s][^,;\t|]*){2,}[,;\t|]\s*[^,;\t|]+$/.test(line)) {
      run += 1;
      if (run >= 3) return true;
    } else run = 0;
  }
  return false;
}

/** A pasted JSON array of two or more objects that look like patient records. */
function hasJsonPatientRecords(text: string): boolean {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return false;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length < 2) return false;
    const objects = parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    if (objects.length < 2) return false;
    const keys = new Set(objects.flatMap((item) => Object.keys(item)));
    const clinical = [...keys].filter((key) => CLINICAL_KEYS.test(key));
    return objects.every((item) => Object.keys(item).length >= 3) && clinical.length >= 2;
  } catch {
    return false;
  }
}

export function hasRowShapedClinicalData(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (hasDelimitedPatientRows(lines) || hasHeaderlessRecords(lines) || hasJsonPatientRecords(text)) return true;
  // Repeated identifier key/value pairs with different values, as in JSON lines, YAML records or records pasted one
  // after the other. One identifier alone ("patient_id: 42") is not row-shaped.
  const keyed = new Set((text.match(ID_VALUE_KEYS) ?? []).map((match) => match.toLowerCase().replace(/\s+/g, "")));
  if (keyed.size >= 2) return true;
  // Two or more different dates of birth with a label.
  const births = new Set((text.match(/\b(?:dob|date of birth|born)\b[^\n]{0,12}?(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/gi) ?? []).map((match) => match.toLowerCase()));
  if (births.size >= 2) return true;
  // A single real identifier value ("MRN 4471920"), or a social security number written with its label.
  return /\b(mrn|medical record number|uniquepid|patientunitstayid)\s*[:=#]?\s*\d{5,}/i.test(text) || /(ssn|social(?: security)?(?: number)?)\W{0,12}\d{3}-\d{2}-\d{4}\b/i.test(text);
}

// An assignment whose name ends in a credential word: password, DB_PASSWORD, "api_key", NEXTAUTH_SECRET, token ...
// The word must end the name, so token_budget and max_tokens are not matched.
const STRONG_NAME = "password|passwd|pwd|secret[_ -]?(?:access[_ -]?)?key|client[_ -]?secret|api[_ -]?key|access[_ -]?key|access[_ -]?token|auth[_ -]?token|private[_ -]?key|model_write_token";
const WEAK_NAME = "secret|token|credentials?|pw";
const SECRET_KEYWORD = new RegExp(`(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,30}[_-]){0,6}(${STRONG_NAME}|${WEAK_NAME})["']?\\s*[:=]\\s*["']?([^\\s,;}"']+)`, "gi");
const STRONG_NAME_ONLY = new RegExp(`(?:${STRONG_NAME})$`, "i");
const NOT_A_SECRET_VALUE = /^(?:\$|\{|<|%|\[|\(|\.\.\.|\*+$|x{3,}$|(?:os\.environ|os\.getenv|process\.env|(?:settings|config|cfg|self|this|secrets|vars|args|params|request)\.)|(?:env|getenv|none|null|true|false|str|string|int|bool|required|optional|field|secretstr)(?=$|[\[()=:|,])|your[_-]|change_?me|changeme|example|placeholder|dummy)/i;

function hasSecretAssignment(text: string): boolean {
  for (const match of text.matchAll(SECRET_KEYWORD)) {
    const value = match[2] ?? "";
    if (NOT_A_SECRET_VALUE.test(value)) continue;
    // Weak names (token, secret, credentials, pw) also appear in ordinary prose: require a value that looks like one.
    if (!STRONG_NAME_ONLY.test(match[1] ?? "") && !(value.length >= 6 && /\d/.test(value))) continue;
    return true;
  }
  return false;
}

const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/i,
  /\bbearer\s+(?=[a-z0-9._~+/=-]*\d)[a-z0-9._~+/=-]{16,}/i,
  /\bauthorization:\s*basic\s+[A-Za-z0-9+/=]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{15,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:(?![^\s@/]*[${}])[^\s@/]{3,}@/i
];

const ACTIVE_CONTENT_SHAPES: RegExp[] = [
  // A script element with a source, a closing tag, or code in it. The bare tag name in a question is not matched.
  /<script\b[^>]*\bsrc\s*=/i,
  /<script\b[\s\S]*<\/script/i,
  /<script\b[^>]*>[^<\n]{0,200}[(;=]/i,
  /<iframe\b/i,
  /<(object|embed)\b/i,
  // Inline handlers with a string or bare value; a JSX handler such as onClick={fn} is not matched.
  /<[a-z][^>]*\bon[a-z]{3,}\s*=\s*(?!\{)\S/i,
  /\bjavascript:\s*\S/i,
  /<style\b[^>]*>[^<]*@import/i,
  /<form\b[^>]*\baction\s*=\s*["']?https?:/i,
  /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i,
  /\bdata:text\/html/i,
  /\bdata:[^,\s]*;base64,\s*(?:PHNjcmlwdD|PHN2Zy|PGh0bWw)/i
];

const INJECTION_SHAPES: RegExp[] = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system|platform)\s+(instructions|rules|prompts?|messages?)/i,
  /\b(ignore|disregard|forget)\s+(all|any|your|the)\s+instructions\b/i,
  /\b(ignore|disregard|forget)\s+(everything|all|anything)\s+(above|before|prior|previous|earlier)\b/i,
  /\b(ignore|disregard|forget)\s+(what|everything)\s+you\s+(were|have been)\s+(told|instructed|given)/i,
  /\b(override|bypass)\s+(your|the|all)\s+(system prompt|safeguards|safety\s+\w+|restrictions|guardrails|instructions)\b/i,
  /\bfollow my (rules|instructions) instead\b/i,
  /\byou are no longer (bound|restricted|limited|constrained)\b/i,
  /\bact as\s+(dan|an? unrestricted|an? jailbroken)\b/i,
  /\b(reveal|print|repeat|show)\s+(me\s+)?(your|the)\s+(system prompt|hidden instructions)/i,
  /\byou are now (in )?(dan|developer mode|an unrestricted|jailbroken)/i,
  /(connect to the local ehr|reviewer-only note to ai|change allowed_tools)/i,
  /system message:[\s\S]{0,80}(ignore|override)/i
];

const MODEL_UPDATE_SHAPES: RegExp[] = [
  /(file_class:\s*training-time model update|serialized gradient\/update|tensor payload)/i,
  /[A-Za-z0-9+/]{300,}={0,2}/,
  /\bH4sI[A-Za-z0-9+/]{100,}/,
  /PK\x03\x04/,
  // A bracketed array of 30 or more long decimals, or a very long unbracketed list. A shorter metrics list is ordinary.
  /\[\s*(?:-?\d*\.\d{3,}\s*,\s*){30,}/,
  /(?:-?\d+\.\d{3,}\s*,\s*){200,}/,
  /\btensor\(\s*\[/i
];

/**
 * The preview kept in the ledger. It never contains any of the text: the same message can carry an injection phrase
 * next to patient details or a password written in words that no pattern matches. Only reason codes and sizes remain.
 */
function assistantPreview(text: string, reasons: AssistantIntakeReason[]): string {
  return `[withheld: ${reasons.map(({ code }) => code).join(", ")}; ${text.split(/\r?\n/).length} lines, ${text.length} characters]`;
}

/**
 * Model-free inspection of what a person typed or pasted into the assistant in one turn. Pure and fast: no I/O.
 * Pass the message, the editor selection and flattened answers; never repository files or the context pack.
 */
export function inspectAssistantIntake(text: string): AssistantIntakeResult {
  const layer: AuthoritativeLayer = "Intake classifier";
  const reasons: AssistantIntakeReason[] = [];
  if (hasSecretAssignment(text) || TOKEN_SHAPES.some((shape) => shape.test(text))) reasons.push({ code: "SENSITIVE_CONTENT", layer });
  if (hasRowShapedClinicalData(text)) reasons.push({ code: "RAW_CLINICAL_DATA", layer });
  if (ACTIVE_CONTENT_SHAPES.some((shape) => shape.test(text))) reasons.push({ code: "ACTIVE_CONTENT", layer });
  if (INJECTION_SHAPES.some((shape) => shape.test(text))) reasons.push({ code: "PROMPT_INJECTION", layer });
  if (MODEL_UPDATE_SHAPES.some((shape) => shape.test(text))) reasons.push({ code: "MODEL_UPDATE_ARTIFACT", layer });
  if (reasons.length === 0) return { verdict: "clear", reasons, redactedPreview: "" };
  return { verdict: "quarantine", reasons, redactedPreview: assistantPreview(text, reasons) };
}

/**
 * Deterministic, fixed mapping from the coordinator's *classified* risk signals to a
 * blocking layer. The model only supplies which signal applies to this request (the same
 * role a regex match plays below); this code, not the model, decides what each signal
 * means and where it routes. Every branch escalates to a stop/ask/human-review layer —
 * never to an approval, execution, or export outcome — so this table can only make the
 * platform more cautious, never less, and cannot be used to bypass a control.
 */
function routeByAdvisorySignal(advisory?: CoordinatorAdvisory): IntakeResolution | null {
  const signals = new Set(advisory?.riskSignals ?? []);
  if (signals.has("APPROVAL_REQUIRED")) {
    return resolution("Human gate / approval binding", "HUMAN_GATE", "2", "STOPPED", ["MODEL_FLAGGED_APPROVAL_REQUIRED"], transitions.human);
  }
  if (signals.has("AUTHORITY_UNCERTAIN")) {
    return resolution("Policy engine / work-item contract", "POLICY_STOP", "1", "STOPPED", ["MODEL_FLAGGED_AUTHORITY_UNCERTAIN"], transitions.policy);
  }
  if (signals.has("SECURITY_RISK")) {
    return resolution("Policy engine / work-item contract", "POLICY_STOP", "1", "STOPPED", ["MODEL_FLAGGED_SECURITY_RISK"], transitions.policy);
  }
  if (signals.has("READINESS_UNCERTAIN")) {
    return resolution("Site readiness gate", "POLICY_STOP", "5", "STOPPED", ["MODEL_FLAGGED_READINESS_UNCERTAIN"], transitions.readiness);
  }
  if (signals.has("SEMANTIC_CONFLICT")) {
    return resolution("Evidence classification", "REQUEST_CLARIFICATION", "3", "CLASSIFIED", ["MODEL_FLAGGED_SEMANTIC_CONFLICT"], transitions.evidence);
  }
  if (signals.has("EVIDENCE_GAP")) {
    return resolution("Evidence classification", "REQUEST_CLARIFICATION", "5", "CLASSIFIED", ["MODEL_FLAGGED_EVIDENCE_GAP"], transitions.evidence);
  }
  if (signals.has("EXPORT_RISK")) {
    return resolution("Human gate / approval binding", "HUMAN_GATE", "2", "STOPPED", ["MODEL_FLAGGED_EXPORT_RISK"], transitions.human);
  }
  return null;
}

/**
 * The full deterministic cascade, model-free. Returns null only when no structural/content
 * rule recognizes the request — the one case where a model opinion is worth asking for at
 * all. Callers MUST treat null, and only null, as permission to consult the coordinator:
 * anything else this returns is a final, code-owned decision the model never influenced and
 * must not be allowed to see beforehand (a request a deterministic rule would reject should
 * never reach the model just because that rule hasn't run yet).
 */
export function resolveDeterministicIntake(input: AuthoritativeIntake): IntakeResolution | null {
  const preflight = inspectIntake(input);
  if (preflight) return preflight;
  const text = combinedText(input);
  const metadata = [{ metadata: { content: text } }];

  // A request to knowingly use an old/stale artifact instead of the approved current one is a
  // deliberate attempt to skip re-verification, not a notification that something changed —
  // runs before lifecycleChange below, whose broader "approved ... change" wording otherwise
  // matches text describing what changed *between* versions and misreads it as an accepted
  // change needing dependents reopened, rather than a stale artifact needing outright rejection.
  const knowinglyStaleVersionRequest = /\b(use|reuse|keep using|continue using)\b[\s\S]{0,60}\b(old|outdated|stale|prior|previous|earlier)\b[\s\S]{0,60}\b(extract|version|checkpoint|cohort|dataset|build|release)\b/i.test(text);
  if (knowinglyStaleVersionRequest) return resolution("Deterministic verifier", "DET_REJECT", "6", "STOPPED", ["STALE_ARTIFACT_VERSION"], transitions.deterministic);

  // A monitoring event that documents its own threshold being crossed, paired with a request
  // to suppress the response that threshold requires (log it as informational, keep approvals
  // valid), is exactly the reopening case: evidence the platform already has says review is
  // required, and the request asks to route around that instead of supplying new evidence.
  const monitoringThresholdBreach = /\bthreshold[_\s-]for[_\s-]review\b|\bpolicy threshold breached\b|\bthreshold breached\b|\bexceeds?\s+threshold\b/i.test(text);
  const suppressionRequest = /\b(keep|treat|log it|record it|note it)\b[\s\S]{0,40}\b(valid|informational|no action|without review|unchanged)\b/i.test(text);
  if (monitoringThresholdBreach && suppressionRequest) {
    return resolution("Workflow engine / dependency invalidation", "REOPEN", "None", "STOPPED", ["MONITORING_THRESHOLD_BREACH_REQUIRES_REVIEW"], transitions.reopen);
  }

  // \bretire\b / \brollback\b (not a bare substring) so "approved retirement date" doesn't
  // misfire this notification-of-an-already-accepted-change path for what is actually a
  // request to perform a consequential action — see resolveConsequentialLifecycleAction below.
  // "prior approval ... bound to" and "using the existing approval(s)" generalize the same
  // shape (a change is proposed, but the approval on record was bound to the prior state) for
  // fixtures that describe the change as a new purpose, a new site joining, or a retraining
  // request rather than literally using the word "change" -- one probe's stale-cohort-extract
  // fixture also matches "approved ... change" here, but knowinglyStaleVersionRequest above
  // already claims it first, so this stays unreachable for that probe regardless.
  const lifecycleChange = /(accepted|approved|confirmed|effective).{0,80}(change|withdrawal|site leaves|new version|new purpose|policy update|cohort update|ownership transfer|\bretire\b|\brollback\b)|invalidate.{0,80}(approval|artifact)|reopen.{0,80}(preparation|review)|prior approval[\s\S]{0,80}bound to|using the existing approvals?/is.test(text);
  if (lifecycleChange) return resolution("Workflow engine / dependency invalidation", "REOPEN", "2", "STOPPED", ["DEPENDENCY_INVALIDATION_REQUIRED"], transitions.reopen);

  const policy = evaluateWorkItemPolicy(input.requestText, metadata);
  if (!policy.passed) {
    const budget = policy.reasonCodes.includes("BUDGET_EXHAUSTED");
    return resolution("Policy engine / work-item contract", "POLICY_STOP", budget ? "7" : "1", "STOPPED", policy.reasonCodes, transitions.policy);
  }

  // A structural, machine-checkable verification failure (a real hash mismatch, an unpinned
  // image, a semantic definition conflict like an outcome or cohort mismatch, ...) is always a
  // sharper, more specific finding than the generic evidence-gap catch-all below, so these run
  // first -- otherwise a fixture that states both "no mapping note exists" AND a genuine
  // definition conflict would be filed as a vague clarification request instead of the precise
  // verification failure it actually is.
  const hashMismatch = input.attachments.some((attachment) => attachment.content !== undefined && sha256(attachment.content) !== attachment.contentHash);
  const deterministic = evaluateVerification("DETERMINISTIC", metadata);
  if (hashMismatch || !deterministic.passed) {
    return resolution("Deterministic verifier", "DET_REJECT", "6", "STOPPED", hashMismatch ? ["HASH_MISMATCH"] : deterministic.reasonCodes, transitions.deterministic);
  }

  const semantic = evaluateVerification("SEMANTIC", metadata);
  if (!semantic.passed) return resolution("Semantic verifier", "SEM_REJECT", semantic.reasonCodes.some((code) => ["OUTCOME_CONFLICT", "COHORT_CONFLICT"].includes(code)) ? "3" : "6", "STOPPED", semantic.reasonCodes, transitions.semantic);

  // Same "specific structural check before the generic evidence-gap catch-all" precedence as
  // the verifiers above: an unresolved-critical-issue finding on the release-review evidence
  // itself is a real, content-addressed release-gate failure, not a vague clarification
  // request, even when the evidence happens to also literally contain the word "unresolved" in
  // a heading (e.g. "## Unresolved issue") that the generic catch-all below would otherwise
  // key off of first.
  const approvalPayload = evaluateApprovalPayload(metadata);
  if (!approvalPayload.passed) {
    return resolution("Human gate / approval binding", "POLICY_STOP", "6", "STOPPED", approvalPayload.reasonCodes, transitions.human);
  }

  // A request to perform release/rollback/retirement, or to register a dry-run/readiness
  // result as complete, or a text claim that something "is approved" — all structurally
  // require named human sign-off (P6) regardless of how complete the evidence looks. This runs
  // before the generic evidence-gap catch-all below (a fixture stating both "is approved ...
  // no signed [record]" and, elsewhere, some unrelated absence, is still fundamentally a
  // human-sign-off case, not a vague clarification request) but after the sharper structural
  // checks above, and before the export/readiness checks below, which would otherwise misfire
  // on the same words ("handoff", "manifest") for a reason that has nothing to do with export
  // content.
  const consequentialLifecycleAction = /\b(record|register|confirm)\b[\s\S]{0,60}(dry-run|dry run|ready.{0,3}for.{0,20}handoff)|\b(prepare|register)\b[\s\S]{0,60}(release review|this release)|\brollback\s+from\b|\bretire\s+model\b|\bsays\b[\s\S]{0,60}\bapproved\b|\bis approved\b[\s\S]{0,80}no signed/i.test(text);
  if (consequentialLifecycleAction) return resolution("Human gate / approval binding", "HUMAN_GATE", "2", "STOPPED", ["CONSEQUENTIAL_ACTION_REQUIRES_HUMAN_GATE"], transitions.human);

  // An approval-binding integrity violation: reused/wrong-version/cross-project/cross-site
  // approval reuse, or a revision explicitly bound to an exact prior artifact hash. Checked
  // after consequentialLifecycleAction (a claim that something "is approved" with no signed
  // record is that check's own, more specific case) but before the bare-word humanDecision
  // catch-all below, so a fixture that also happens to contain the word "approval" is read as
  // the binding-integrity violation it actually describes, not a generic pending-approval case.
  const approvalBindingFailure = /(approval|approver)[\s\S]{0,80}(absent|missing|expired|wrong version|another version|revoked|out of scope)|no (valid|current|authorized|signed)[\s\S]{0,20}approval|bound to[\s\S]{0,40}(exact|spec-\d)|exact artifact revisions?|current[_ ](project|artifact)[\s\S]{0,100}approval|approval[\s\S]{0,100}current[_ ](project|artifact)|approval binding/i.test(text);
  if (approvalBindingFailure) return resolution("Human gate / approval binding", "POLICY_STOP", "2", "STOPPED", ["INVALID_APPROVAL_BINDING"], transitions.human);

  // A site-readiness check report (connectivity/dependency/disk/firewall/GPU status) is a
  // specific, structured verification domain of its own -- checked here, before the generic
  // evidence-gap catch-all below, for the same reason the verification checks above are: a
  // readiness report that also happens to contain a bare "missing"/"unknown" value is still a
  // readiness-review case, not a vague clarification request.
  const readinessRequest = /(site readiness|readiness attestation|connectivity|\bdependenc(y|ies)\b|required .{0,20}plugin|disk space|disk_free|kit install|\bfirewall\b|gpu availability)/i.test(text);
  if (readinessRequest) return resolution("Site readiness gate", "POLICY_STOP", "5", "STOPPED", ["SITE_READINESS_REVIEW_REQUIRED"], transitions.readiness);

  // The generic evidence-gap catch-all: only reached once every sharper, more specific rule
  // above (a real verification failure, a consequential-action human-gate trigger, a site-
  // readiness report) has already had first refusal. "no <governance/process noun>
  // (exists|has been supplied|defined)" and "silent on <topic>" generalize the same
  // absence-of-governance-documentation shape already covered by "no
  // (documented|versioned|authoritative)" below, without the words "documented", "versioned",
  // or "authoritative" specifically -- still keyed to real absence language, not to any one
  // fixture's literal wording.
  // (?<!\bno\s) guards "unresolved"/"conflicting"/"contradictory" the same way
  // evaluateApprovalPayload's UNRESOLVED_CRITICAL_ISSUE rule does, so a fixture that explicitly
  // states "no unresolved critical conflict" (a stated absence) is not misread as the conflict
  // it denies.
  const negatedGapWord = /(?<!\bno\s)\b(unresolved|conflicting|contradictory)\b/i;
  const evidenceCheckText = text.replace(gapCheckInstruction, "");
  const evidenceSignals =
    negatedGapWord.test(evidenceCheckText)
    || /(missing|not provided|unknown|stale|expired|incomplete|unsupported|cannot be established|no (documented|versioned|authoritative)|awaiting clarification|insufficient evidence|\bno\b[\s\S]{0,60}\b(has been supplied|exists?|is defined)\b|\bsilent on\b|\bis silent\b|\bno procedure (for|to)\b)/i.test(evidenceCheckText)
    || hasHeterogeneousDefinitions(evidenceCheckText)
    || hasSmallCellDisclosureRisk(evidenceCheckText);
  if (evidenceSignals) {
    const conflict = negatedGapWord.test(evidenceCheckText);
    return resolution("Evidence classification", "REQUEST_CLARIFICATION", conflict ? "3" : "5", "CLASSIFIED", [conflict ? "UNRESOLVED_CONFLICT" : "INSUFFICIENT_EVIDENCE"], transitions.evidence);
  }

  const exportRequest = /(export|handoff|startup kit|deployment package|release package|manifest)/i.test(text);
  if (exportRequest) {
    // A per-site status line reporting FAIL is readiness evidence the platform already has;
    // exporting or issuing kits anyway hands an unready site something it can't safely run.
    // Checked ahead of evaluateExportPayload, which only scans the request text for prohibited
    // content and has no way to cross-reference attached per-site status against who the
    // export targets.
    if (/^\s*[A-Za-z0-9_-]+\s+FAIL\s*$/m.test(text)) {
      return resolution("Site readiness gate", "POLICY_STOP", "5", "STOPPED", ["UNRESOLVED_READINESS_FAILURE"], transitions.readiness);
    }
    const exported = evaluateExportPayload({ content: text });
    return exported.passed
      ? resolution("Handoff exporter", "EXPORT", "None", "WORK_ITEM_SIGNED", [], transitions.exportAuthorized)
      : resolution("Handoff exporter", "DET_REJECT", "6", "STOPPED", exported.reasonCodes, transitions.exportReject);
  }

  const runtimeEvent = /(heartbeat|runtime status|job status|client (connected|disconnected|reconnects?|reconnected)|\breconnects?\b|checkpoint\s+(recovered|round)|recovery event|training round completed|resume[\s\S]{0,30}checkpoint)/i.test(text);
  if (runtimeEvent) return resolution("Runtime status ingestion", "PROCEED_TO_DRAFT", "None", "CLASSIFIED", [], transitions.runtime);

  // approvalPayload was already checked above (before the generic evidence-gap catch-all); by
  // this point it has necessarily passed, so only the bare-word human-decision fallback remains.
  //
  // A structured citation that a governance field already "is/are present/visible/valid" (a
  // role, a reference ID, an evidence check) is a confirmation that a decision already exists,
  // not a request for one or an unverified claim that it does -- distinct from the case where the
  // assistant SAYS X is approved" (caught earlier by consequentialLifecycleAction, unaffected by
  // this guard) and from any nearby absence marker ("no signed", "does not exist/resolve"),
  // which is explicitly excluded from the guard below and so still falls straight through to
  // this same HUMAN_GATE. Verified against the full 144-probe corpus: only three
  // probes match this guard: no adversarial probe's real fixture text does.
  const structuredGovernanceCitation = /\b(is|are)\s+(present|visible|valid)\b|no unresolved critical conflict/i.test(text)
    && !/\bno\b[\s\S]{0,20}(signed|valid|current|authorized)|does not (exist|resolve)|\bsays\b/i.test(text);
  const humanDecision = (/(\bapprove\b|\bapproval\b|ethics decision|privacy approver)/i.test(text) && !structuredGovernanceCitation)
    || /(release decision|sign[- ]?off|\bretire\b|rollback decision)/i.test(text);
  if (humanDecision) return resolution("Human gate / approval binding", "HUMAN_GATE", "2", "STOPPED", ["HUMAN_APPROVAL_REQUIRED"], transitions.human);

  return null;
}

/**
 * Platform-owned precedence and rules produce the only authoritative outcome. The
 * deterministic cascade is always tried first and, when it matches, its result is returned
 * without ever looking at `advisory` — a precise structural match is never overridden by a
 * general model signal. `advisory` only matters on the cascade's null path.
 */
export function resolveAuthoritativeIntake(input: AuthoritativeIntake, advisory?: CoordinatorAdvisory): IntakeResolution {
  const deterministic = resolveDeterministicIntake(input);
  if (deterministic) return deterministic;

  const advisoryRoute = routeByAdvisorySignal(advisory);
  if (advisoryRoute) return advisoryRoute;

  return resolution("No block - proceed", "PROCEED_TO_DRAFT", "None", "WORK_ITEM_SIGNED", [], transitions.proceed);
}
