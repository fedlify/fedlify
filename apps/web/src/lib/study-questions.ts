/**
 * Study questions: the 29 requirements (requirements-catalog.ts) as plain questions, their statuses and evidence
 * classes, and the pure helpers the routes share. No database or network code here (see study-questions-store.ts and
 * study-questions-model.ts), so screens and tests can use it too.
 *
 * The rule that holds everywhere: the assistant drafts and proposes, a person decides. A row the assistant wrote is
 * SUGGESTED, UNKNOWN or CONFLICT and never counts as answered. Only a person turns it into ANSWERED or ASSUMED.
 */
import { sha256 } from "@/lib/crypto";
import { countsAsAnswered } from "@/lib/governance";
import { REQUIREMENT_ORDER, REQUIREMENTS, type RequirementId } from "@/lib/requirements-catalog";

export const QUESTION_STATUSES = ["ANSWERED", "SUGGESTED", "ASSUMED", "UNKNOWN", "CONFLICT"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
/** A question with no stored row. Never written to the database. */
export type ChecklistStatus = QuestionStatus | "MISSING";

export const EVIDENCE_CLASSES = ["fact", "assumption", "proposal", "unknown", "conflict"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Longest description the draft accepts, in characters. */
export const DRAFT_MAX_CHARS = 40_000;
export const SOURCE_NOTE_MAX = 500;
export const ANSWER_MAX = 4000;
/** How many open questions "Ask me the open questions" shows at a time. */
export const OPEN_QUESTIONS_BATCH = 4;

/** The eight groups C1 to C8 of the method paper, with plain names. */
export const QUESTION_CATEGORIES: Array<{ id: string; name: string; ids: RequirementId[] }> = [
  { id: "C1", name: "Purpose and who takes part", ids: ["R01", "R02", "R03"] },
  { id: "C2", name: "Permissions, ownership and approvals", ids: ["R04", "R05", "R06", "R07"] },
  { id: "C3", name: "The data and its quality", ids: ["R08", "R09", "R10", "R11"] },
  { id: "C4", name: "Computers and sites being ready", ids: ["R12", "R13", "R14", "R15"] },
  { id: "C5", name: "Privacy and security", ids: ["R16", "R17", "R18", "R19"] },
  { id: "C6", name: "How the training runs", ids: ["R20", "R21", "R22", "R23"] },
  { id: "C7", name: "Checking and releasing the result", ids: ["R24", "R25", "R26"] },
  { id: "C8", name: "Using it and keeping it going", ids: ["R27", "R28", "R29"] }
];

export function categoryOf(id: RequirementId) {
  return QUESTION_CATEGORIES.find((category) => category.ids.includes(id)) ?? QUESTION_CATEGORIES[0]!;
}

/** The catalog's own wording is formal; these are the questions people see. */
export const PLAIN_QUESTIONS: Record<RequirementId, string> = {
  R01: "What is the study for, who is it about, and why should the sites learn together instead of sharing their data?",
  R02: "Which sites will take part, and what can each one contribute in data, computers and staff?",
  R03: "Who is on the team, at each site and across the study, and how will they work together and agree on terms?",
  R04: "Which legal and ethics permissions are in place, and what agreements do the sites have with each other?",
  R05: "Who owns the data, the model and the results, and who makes the final decisions?",
  R06: "How much oversight does this study need, and who has to approve before each big step?",
  R07: "How do sites join, change or leave the study, and what happens to their data and contribution when they do?",
  R08: "Which data fields and formats must every site use so the data lines up?",
  R09: "How will each site prepare, label and clean its data in the same way?",
  R10: "How will each site check that its data is good enough to train on?",
  R11: "How different are the sites' patients and data, and how will the data be split for training and testing?",
  R12: "Do the sites have enough computing power, storage and network connection, and are they reliably available?",
  R13: "Which software versions will every site run, and how will you keep them the same?",
  R14: "How will the study software reach the hospital data safely, without patient data leaving the site?",
  R15: "How will new sites be set up and tried out before they take part in a real run?",
  R16: "What could go wrong for privacy or security, and which protections match those risks?",
  R17: "Who can sign in and do what, and how are passwords and keys kept safe?",
  R18: "How is information protected while it travels between the sites and the study server?",
  R19: "How will you make sure code and results were not tampered with, and what is the plan if something goes wrong?",
  R20: "What are the exact training steps: the model, the number of rounds, how updates are combined, and when training stops?",
  R21: "How will training cope with sites that have different amounts of data or slower computers?",
  R22: "What happens if a site drops out or a run fails, and how is progress saved?",
  R23: "How will the team see what happened during a run, and how does each site approve what leaves it?",
  R24: "How will you measure the model: which measures, on which data, and for which patient groups?",
  R25: "Who checks the result independently, and what must be true before the model is released?",
  R26: "What will be written down so someone else can repeat the study and find the final model?",
  R27: "How will the model fit into clinical work, and who needs training to use it?",
  R28: "How will you watch the model after release for drift, fairness, security and rule problems?",
  R29: "Who looks after updates, retraining, rollback and eventual retirement of the model, and how is that kept going?"
};

export type StoredQuestionRow = {
  id?: string;
  requirementId: string;
  answer: string;
  status?: string | null;
  evidenceClass?: string | null;
  sourceNote?: string | null;
  respondedById?: string | null;
  confirmedById?: string | null;
  confirmedAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export function isRequirementId(value: string): value is RequirementId {
  return (REQUIREMENT_ORDER as string[]).includes(value);
}

export function rowStatus(row?: Pick<StoredQuestionRow, "status"> | null): ChecklistStatus {
  if (!row) return "MISSING";
  return (QUESTION_STATUSES as readonly string[]).includes(row.status ?? "") ? (row.status as QuestionStatus) : "ANSWERED";
}

/** A row a person put there: the draft must never overwrite it. */
export function isPersonAnswer(row?: Pick<StoredQuestionRow, "status"> | null): boolean {
  return Boolean(row) && countsAsAnswered(row!.status);
}

/** "Not decided yet" that a person chose (it carries who and when). A draft leaves it alone. */
export function isPersonMark(row?: Pick<StoredQuestionRow, "status" | "confirmedById"> | null): boolean {
  return Boolean(row) && row!.status === "UNKNOWN" && Boolean(row!.confirmedById);
}

export function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Hash over the ordered answers (id, status, answer), stored when the specification is confirmed. */
export function specificationHash(rows: StoredQuestionRow[]): string {
  const byId = new Map(rows.map((row) => [row.requirementId, row]));
  const ordered = REQUIREMENT_ORDER.map((id) => {
    const row = byId.get(id);
    return [id, rowStatus(row), row?.answer ?? ""];
  });
  return sha256(JSON.stringify(ordered));
}

export type ChecklistItem = {
  id: RequirementId;
  title: string;
  definition: string;
  category: string;
  categoryName: string;
  question: string;
  answer: string;
  status: ChecklistStatus;
  evidenceClass: string | null;
  sourceNote: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  /** The stored row, for older screens. Null when nothing is stored. */
  response: StoredQuestionRow | null;
};

export type ChecklistCounts = { total: number; answered: number; assumed: number; suggested: number; unknown: number; conflict: number; missing: number };

export type ChecklistPayload = {
  requirements: ChecklistItem[];
  counts: ChecklistCounts;
  specification: { confirmedAt: string | null; confirmedByName: string | null };
  /** STUDY_QUESTIONS_STRICT: Publish also needs the specification confirmed. */
  strict: boolean;
  /** Same as before: how many questions count as answered (ANSWERED and ASSUMED). */
  answeredCount: number;
  totalCount: number;
  missing: RequirementId[];
  allowed: boolean;
};

const iso = (value?: Date | string | null) => (value ? new Date(value).toISOString() : null);

export function buildChecklist(input: {
  rows: StoredQuestionRow[];
  names: Map<string, string>;
  specification: { confirmedAt?: Date | string | null; confirmedById?: string | null };
  strict: boolean;
}): ChecklistPayload {
  const byId = new Map(input.rows.map((row) => [row.requirementId, row]));
  const counts: ChecklistCounts = { total: REQUIREMENT_ORDER.length, answered: 0, assumed: 0, suggested: 0, unknown: 0, conflict: 0, missing: 0 };
  const requirements = REQUIREMENT_ORDER.map((id): ChecklistItem => {
    const row = byId.get(id) ?? null;
    const status = rowStatus(row);
    if (status === "ANSWERED") counts.answered += 1;
    else if (status === "ASSUMED") counts.assumed += 1;
    else if (status === "SUGGESTED") counts.suggested += 1;
    else if (status === "UNKNOWN") counts.unknown += 1;
    else if (status === "CONFLICT") counts.conflict += 1;
    else counts.missing += 1;
    const category = categoryOf(id);
    return {
      id,
      title: REQUIREMENTS[id].title,
      definition: REQUIREMENTS[id].definition,
      category: category.id,
      categoryName: category.name,
      question: PLAIN_QUESTIONS[id],
      answer: row?.answer ?? "",
      status,
      evidenceClass: row?.evidenceClass ?? null,
      sourceNote: row?.sourceNote ?? null,
      confirmedByName: row?.confirmedById ? (input.names.get(row.confirmedById) ?? null) : null,
      confirmedAt: iso(row?.confirmedAt),
      response: row
    };
  });
  const answered = counts.answered + counts.assumed;
  const missing = requirements.filter((item) => item.status !== "ANSWERED" && item.status !== "ASSUMED").map((item) => item.id);
  return {
    requirements,
    counts,
    specification: {
      confirmedAt: iso(input.specification.confirmedAt),
      confirmedByName: input.specification.confirmedById ? (input.names.get(input.specification.confirmedById) ?? null) : null
    },
    strict: input.strict,
    answeredCount: answered,
    totalCount: REQUIREMENT_ORDER.length,
    missing,
    allowed: missing.length === 0
  };
}

/** The next open items: disagreements first, then the rest in catalog order. Open means UNKNOWN, CONFLICT or no row. */
export function nextOpenItems(rows: StoredQuestionRow[], limit = OPEN_QUESTIONS_BATCH): RequirementId[] {
  const byId = new Map(rows.map((row) => [row.requirementId, row]));
  const open = REQUIREMENT_ORDER.filter((id) => {
    const status = rowStatus(byId.get(id));
    return status === "MISSING" || status === "UNKNOWN" || status === "CONFLICT";
  });
  const conflicts = open.filter((id) => rowStatus(byId.get(id)) === "CONFLICT");
  return [...conflicts, ...open.filter((id) => !conflicts.includes(id))].slice(0, limit);
}

const squash = (text: string) => text.toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”"‘’']/g, "'").trim();

/**
 * True when the quote really appears in the text (ignoring case, spacing and quote marks) as whole words, and is long
 * enough to mean something (15 characters or 3 words). This shows the words exist in the text. It does not show that
 * they support the answer: the person still checks.
 */
export function quoteAppearsIn(text: string, quote: string): boolean {
  const needle = squash(quote).replace(/…|\.\.\.$/g, "").trim();
  const words = needle.split(" ").filter(Boolean).length;
  if (needle.length < 15 && words < 3) return false;
  const hay = squash(text);
  let from = hay.indexOf(needle);
  const wordChar = /[\p{L}\p{N}]/u;
  while (from !== -1) {
    const before = from === 0 ? "" : hay[from - 1]!;
    const after = hay[from + needle.length] ?? "";
    if (!wordChar.test(before) && !wordChar.test(after)) return true;
    from = hay.indexOf(needle, from + 1);
  }
  return false;
}
