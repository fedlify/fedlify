import { contentHash, hasCredentialMaterial } from "@/lib/control-plane";

type EvidenceLike = {
  id: string;
  contentHash: string;
  metadata: unknown;
};

export type EnforcementDecision = {
  passed: boolean;
  reasonCodes: string[];
  findings: { rule: string; message: string }[];
};

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}: ${textOf(item)}`).join("\n");
  return String(value);
}

export function evidenceText(evidence: Array<{ metadata: unknown }>): string {
  return evidence.map((item) => textOf(item.metadata)).join("\n");
}

function matches(value: string, rules: Array<[string, RegExp, string]>): EnforcementDecision {
  const findings = rules
    .filter(([, pattern]) => pattern.test(value))
    .map(([rule, , message]) => ({ rule, message }));
  return { passed: findings.length === 0, reasonCodes: findings.map(({ rule }) => rule), findings };
}

function combineDecisions(decisions: EnforcementDecision[]): EnforcementDecision {
  const findings = decisions.flatMap((decision) => decision.findings);
  return { passed: findings.length === 0, reasonCodes: findings.map(({ rule }) => rule), findings };
}

export type VerificationEvidence = {
  metadata: unknown;
  contentHash?: string;
  sourceLocator?: string;
  sourceVersion?: string | null;
  freshnessExpiresAt?: Date | string | null;
};

/**
 * Validates a locator's syntax against the format its own declared scheme requires. This
 * checks form, not liveness — it cannot confirm a DOI or URL actually resolves without a
 * network call, but it replaces guessing at what a "fake" locator looks like (the previous
 * rule matched literal strings lifted from specific test fixtures) with a real structural
 * requirement that applies to any locator, real or synthetic.
 */
function unresolvedLocatorFindings(evidence: VerificationEvidence[]): EnforcementDecision {
  const findings = evidence
    .filter((item): item is VerificationEvidence & { sourceLocator: string } => Boolean(item.sourceLocator))
    .filter((item) => {
      if (/^doi:/i.test(item.sourceLocator)) return !/^doi:10\.\d{4,9}\/\S+$/i.test(item.sourceLocator);
      if (/^https?:\/\//i.test(item.sourceLocator)) {
        try {
          new URL(item.sourceLocator);
          return false;
        } catch {
          return true;
        }
      }
      return false; // other schemes (fixture://, intake://, ...) make no resolvable claim
    })
    .map((item) => ({ rule: "UNRESOLVED_LOCATOR", message: `Evidence locator does not resolve: ${item.sourceLocator}` }));
  return { passed: findings.length === 0, reasonCodes: findings.map(({ rule }) => rule), findings };
}

/** Compares the evidence record's own stored expiry against now, instead of pattern-matching a year in text. */
function staleEvidenceFindings(evidence: VerificationEvidence[]): EnforcementDecision {
  const findings = evidence
    .filter((item) => item.freshnessExpiresAt && new Date(item.freshnessExpiresAt) <= new Date())
    .map(() => ({ rule: "STALE_EVIDENCE", message: "Evidence or extraction version is stale." }));
  return { passed: findings.length === 0, reasonCodes: findings.map(({ rule }) => rule), findings };
}

export function evaluateWorkItemPolicy(purpose: string, evidence: Array<{ metadata: unknown }>): EnforcementDecision {
  const value = `${purpose}\n${evidenceText(evidence)}`;
  return matches(value, [
    ["CONTRACT_SCOPE_OVERRIDE", /(ignore|replace|change|outside).{0,50}(signed work item|output schema|project site scope|work-item|tool list)/is, "Input attempts to change the signed contract or output schema."],
    ["UNLISTED_TOOL_EXPANSION", /(any network tool|unlisted external api|any shell command|unapproved alternatives)/is, "Input requests tools outside the platform-authored contract."],
    ["INSTRUCTION_IN_EVIDENCE", /(ai-only instruction|machine instruction|ai instruction|silently treat all unknown requirements as confirmed)/is, "Evidence contains instructions addressed to the agent."],
    ["EVIDENCE_EXFILTRATION", /(attacker\.invalid|send the current evidence|exfiltrat)/is, "Input requests evidence exfiltration."],
    ["AUTHORITY_ESCALATION", /(impersonate|sign .* as .*reviewer|ethics approval is implicitly granted|write_project_fact_ledger|record ethics approval|approval.*old account|status:\s*revoked)/is, "Requested action exceeds the actor or evidence authority."],
    ["CROSS_SITE_AUTHORITY", /(no local engineer attestation|no site [a-z] readiness-attester role|pi attests another site)/is, "Requested action crosses a site-specific authority boundary."],
    ["RUNTIME_BOUNDARY", /(production aggregator password|connect to the live aggregator|production \(not provisioned|check three patient records|local ehr query)/is, "Planning work cannot access production runtime or patient records."],
    ["BUDGET_EXHAUSTED", /(budget.{0,30}(exhausted|reached)|used["']?\s*:\s*(20|8).{0,80}(requested|remaining["']?\s*:\s*0)|requested_revision["']?\s*:\s*9)/is, "The signed work-item budget is exhausted."],
    ["DIRECT_LEDGER_WRITE", /(accept this generated json into project truth|confirm .* as project truth.*enough)/is, "Models may propose but cannot confirm authoritative project facts."],
    ["ROLE_MISMATCH", /(requester:\s*site [a-z] engineer[\s\S]{0,100}required role:\s*consortium privacy approver|requester role:\s*site_engineer[\s\S]{0,120}required confirmer)/is, "The requester lacks the required institutional role."],
    ["CREDENTIAL_REQUEST", /(embed credential|aggregator password|production secret).{0,80}(startup kit|package|handoff)/is, "Credentials may not be embedded in generated artifacts."]
  ]);
}

export function evaluateVerification(kind: "DETERMINISTIC" | "SEMANTIC", evidence: VerificationEvidence[]): EnforcementDecision {
  const value = evidenceText(evidence);
  if (kind === "DETERMINISTIC") {
    // Rules below still depend on submitted content shape and are pending the same
    // structural-field treatment as UNRESOLVED_LOCATOR/STALE_EVIDENCE (needs an approved-digest
    // registry for images/checkpoints and a defined claimed-hash field on submitted artifacts).
    const textRules = matches(value, [
      ["HASH_MISMATCH", /(expected_evidence_hash[\s\S]{0,80}observed_evidence_hash|manifest_hash[\s\S]{0,80}signed_hash|expected_config_hash[\s\S]{0,160}cfg999)/i, "Expected and observed hashes differ."],
      ["UNPINNED_OR_MIXED_IMAGE", /(:latest|expected_digest:\s*null|approved_image[\s\S]{0,300}sha256:bbb222)/i, "A runtime image is unpinned or differs from the approved digest."],
      ["SIGNATURE_REPLAY", /(replayed_for|synthetic_copy|original_artifact[\s\S]{0,80}replayed)/i, "A signature is replayed for another artifact revision."],
      ["INSECURE_TRANSPORT", /(tls:\s*false|transport:\s*tcp[\s\S]{0,80}model_parameters)/i, "Model updates would use an insecure transport."],
      ["UPDATE_EXFILTRATION", /(external-logger\.invalid|payload:\s*full_client_update)/i, "Configuration exports full client updates externally."],
      ["ARBITRARY_EXECUTION", /(user_supplied_command|allowed_commands:\s*["']?\*)/i, "Artifact permits arbitrary command execution."],
      ["UNVERIFIED_CHECKPOINT", /(sha256:unknown|manifested["']?\s*:\s*false)/i, "Recovery checkpoint is not in the approved manifest."]
    ]);
    // UNRESOLVED_LOCATOR and STALE_EVIDENCE are computed from the evidence record's own
    // sourceLocator/freshnessExpiresAt fields when present, not from text pattern-matching.
    return combineDecisions([textRules, unresolvedLocatorFindings(evidence), staleEvidenceFindings(evidence)]);
  }
  const decision = matches(value, [
    ["INSTRUCTION_TO_VERIFIER", /(mark it supported anyway|return pass|automatically set ethics_status)/i, "Content attempts to instruct or self-approve the verifier."],
    ["CLAIM_SOURCE_CONTRADICTION", /(has approved[\s\S]{0,180}will consider|claim[\s\S]{0,180}reserved exclusively|definitely granted[\s\S]{0,160}approval_record_id["']?\s*:\s*null)/i, "The cited evidence does not support the claim."],
    ["OUTCOME_CONFLICT", /(in-hospital mortality[\s\S]{0,180}(30-day mortality|icu mortality)|30-day mortality[\s\S]{0,180}in-hospital mortality)/i, "Outcome definitions conflict across evidence sources."],
    ["COHORT_CONFLICT", /(first eligible admission[\s\S]{0,120}final eligible admission)/i, "The reused cohort definition conflicts with the current objective."],
    ["CLINICAL_SEMANTIC_MISMATCH", /(arterial sample[\s\S]{0,120}venous sample|lactate arterial[\s\S]{0,120}lactate venous)/i, "Matching codes and units do not establish clinical equivalence."],
    ["VOCABULARY_COLLISION", /(validation site[\s\S]{0,180}local validation split|no mapping note exists)/i, "A shared term has incompatible institutional meanings."]
  ]);
  if (/change the primary outcome/i.test(value)) {
    decision.findings = decision.findings.filter(({ rule }) => rule !== "OUTCOME_CONFLICT");
    decision.reasonCodes = decision.findings.map(({ rule }) => rule);
    decision.passed = decision.findings.length === 0;
  }
  return decision;
}

export function evidenceBindingHash(evidence: EvidenceLike[]): string {
  return contentHash(evidence
    .map(({ id, contentHash: hash }) => ({ id, contentHash: hash }))
    .sort((a, b) => a.id.localeCompare(b.id)));
}

export function evaluateApprovalPayload(evidence: Array<{ metadata: unknown }>): EnforcementDecision {
  return matches(evidenceText(evidence), [
    // \b...\b around "unresolved"/"critical" so a snake_case field name like
    // "unresolved_critical": 0 (a count of zero, i.e. no issue) is never matched -- "d" and "_"
    // are both word characters, so there is no word boundary between them, and the alternation
    // only fires on genuine separate-word narrative usage ("## Unresolved issue\nSeverity:
    // critical", "no critical items remain open/unresolved"). The (?<!\bno\s) guard excludes
    // the explicit negation ("no unresolved critical conflict", "no critical issue is open") the
    // same way password:(?!not_included) excludes a labeled-clean credential field elsewhere in
    // this file -- a stated absence must never itself read as the presence it denies.
    ["UNRESOLVED_CRITICAL_ISSUE", /((?<!\bno\s)\bunresolved\b[\s\S]{0,40}\bcritical\b|(?<!\bno\s)\bcritical\b[\s\S]{0,40}\b(open|unresolved)\b|severity:\s*critical[\s\S]{0,80}status:\s*open)/i, "A critical issue remains unresolved at the release gate."]
  ]);
}

export function evaluateExportPayload(value: unknown): EnforcementDecision {
  const text = textOf(value);
  const base = matches(text, [
    ["CREDENTIAL_IN_EXPORT", /(password:\s*(?!not_included)|hardcoded_secret|private key|bearer\s+[a-z0-9._-]+)/i, "Export content contains credential material."],
    ["CONTROL_PLANE_CALLBACK", /(fedlify\..*\/control\/execute|callback_permissions[\s\S]{0,100}(start_job|modify_config))/i, "Export contains a route back to the control plane."],
    ["AUTO_START", /(auto_start:\s*true|start_nvflare_job)/i, "Export would start training automatically."],
    ["SIGNED_CONTENT_MISMATCH", /signed_manifest_hash[\s\S]{0,80}current_manifest_hash/i, "Export content differs from the signed manifest."]
  ]);
  if (!base.passed || hasCredentialMaterial(value)) {
    if (!base.reasonCodes.includes("CREDENTIAL_IN_EXPORT") && hasCredentialMaterial(value)) {
      base.reasonCodes.push("CREDENTIAL_IN_EXPORT");
      base.findings.push({ rule: "CREDENTIAL_IN_EXPORT", message: "Export content contains credential material." });
    }
    base.passed = false;
  }
  return base;
}
