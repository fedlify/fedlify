import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const roleSchema = z.enum(["COORDINATOR", "WORKER", "SEMANTIC_VERIFIER", "CODEX_WORKER"]);

export const signedWorkItemSchema = z.object({
  id: z.string().min(1),
  studyId: z.string().min(1),
  skillContractId: z.string().min(1),
  role: roleSchema,
  purpose: z.string().min(1),
  input: z.unknown(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/i),
  evidence: z.array(z.object({ id: z.string(), contentHash: z.string(), content: z.unknown() })).max(100),
  allowedTools: z.array(z.string()).max(30),
  tokenBudget: z.number().int().positive().optional(),
  timeBudgetSeconds: z.number().int().positive().optional(),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
  signedPayload: z.unknown()
});

export const proposalSchema = z.object({
  disposition: z.enum(["PROPOSE", "REQUEST_CLARIFICATION", "POLICY_STOP"]),
  summary: z.string().max(4000),
  claims: z.array(z.object({ statement: z.string(), evidenceIds: z.array(z.string()) })).max(100),
  artifact: z.unknown().optional(),
  unresolved: z.array(z.string()).max(100),
  requestedActions: z.array(z.string()).max(30)
});

export const verificationSchema = z.object({
  disposition: z.enum(["SUPPORTED", "CONTRADICTED", "SCOPE_DRIFT", "INSUFFICIENT_EVIDENCE"]),
  findings: z.array(z.object({ severity: z.enum(["INFO", "WARNING", "ERROR"]), message: z.string(), evidenceIds: z.array(z.string()) })),
  supportedClaimIndexes: z.array(z.number().int().nonnegative()),
  unsupportedClaimIndexes: z.array(z.number().int().nonnegative())
});

export const requirementIdSchema = z.enum([
  "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10",
  "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20",
  "R21", "R22", "R23", "R24", "R25", "R26", "R27", "R28", "R29"
]);

export const coordinatorAdvisorySchema = z.object({
  intent: z.enum([
    "STUDY_PREPARATION", "EVIDENCE_UPDATE", "PROTOCOL_CHANGE", "SITE_READINESS",
    "RUNTIME_EVENT", "APPROVAL_REQUEST", "EXPORT_REQUEST", "RECOVERY_OR_ROLLBACK",
    "OTHER"
  ]),
  requirementIds: z.array(requirementIdSchema).min(1).max(12),
  riskSignals: z.array(z.enum([
    "EVIDENCE_GAP", "SEMANTIC_CONFLICT", "AUTHORITY_UNCERTAIN", "APPROVAL_REQUIRED",
    "READINESS_UNCERTAIN", "EXPORT_RISK", "RUNTIME_CHANGE", "SECURITY_RISK", "NONE"
  ])).max(20),
  requiredCapabilities: z.array(z.string().min(1).max(100)).max(20),
  clarificationQuestions: z.array(z.string().min(1).max(500)).max(10),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1000)
});

export type SignedWorkItem = z.infer<typeof signedWorkItemSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type SemanticVerification = z.infer<typeof verificationSchema>;
export type CoordinatorAdvisory = z.infer<typeof coordinatorAdvisorySchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function verifySignature(payload: unknown, signature: string): boolean {
  const secret = process.env.FEDLIFY_CONTROL_SIGNING_SECRET;
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(canonical(payload)).digest("hex");
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(signature, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
