/**
 * Pure helpers for the "Study questions" tab: plain labels, filters, grouping and the sentences the screen shows.
 * No React and no network code, so they are easy to test. Types only are imported from study-questions.ts.
 */
import { formatDate } from "@/lib/format";
import type { PlanQuestion } from "@/lib/agent-thread-types";
import type { ChecklistItem, ChecklistStatus } from "@/lib/study-questions";

export type QuestionFilter = "all" | "needs" | "check" | "answered";

export const FILTER_LABELS: Record<QuestionFilter, string> = { all: "All", needs: "Needs you", check: "To check", answered: "Answered" };

/** Words for the status tag. `tag` is a StatusTag value that picks the colour. */
export const QUESTION_STATUS_VIEW: Record<ChecklistStatus, { label: string; tag: string; hint: string }> = {
  ANSWERED: { label: "Answered", tag: "DONE", hint: "A person gave or accepted this answer." },
  SUGGESTED: { label: "Suggested: check it", tag: "PENDING", hint: "The assistant wrote this. It does not count until you accept it." },
  ASSUMED: { label: "Assumed", tag: "DRAFT_READY", hint: "An answer you are going ahead with without being sure. Reviewers see it flagged." },
  UNKNOWN: { label: "Not decided", tag: "NOT_STARTED", hint: "Left for later on purpose. It does not count until it has an answer." },
  CONFLICT: { label: "Conflict: please decide", tag: "BLOCKED", hint: "Your description disagrees with itself or with an earlier answer. Write the answer you want to use." },
  MISSING: { label: "No answer yet", tag: "NOT_STARTED", hint: "Nobody has answered this yet." }
};

/** Counts as answered for the gate: a person gave or accepted it. */
export function isDone(status: ChecklistStatus): boolean {
  return status === "ANSWERED" || status === "ASSUMED";
}

export function filterItems<T extends Pick<ChecklistItem, "status">>(items: T[], filter: QuestionFilter): T[] {
  if (filter === "needs") return items.filter((item) => !isDone(item.status));
  if (filter === "check") return items.filter((item) => item.status === "SUGGESTED");
  if (filter === "answered") return items.filter((item) => isDone(item.status));
  return items;
}

/** How many questions each filter shows, for the counts on the filter buttons. */
export function filterCounts<T extends Pick<ChecklistItem, "status">>(items: T[]): Record<QuestionFilter, number> {
  return {
    all: items.length,
    needs: filterItems(items, "needs").length,
    check: filterItems(items, "check").length,
    answered: filterItems(items, "answered").length
  };
}

/**
 * The next question that still needs the person, after `afterId` in the list order (wrapping round), or the first one.
 * Disagreements come first, then suggestions to check, then the rest. Null when nothing needs them.
 */
export function nextNeedingId<T extends { id: string; status: ChecklistStatus }>(items: T[], afterId: string | null = null): string | null {
  const start = afterId ? items.findIndex((item) => item.id === afterId) + 1 : 0;
  const ordered = [...items.slice(start), ...items.slice(0, start)].filter((item) => item.id !== afterId);
  const rank = (status: ChecklistStatus) => (status === "CONFLICT" ? 0 : status === "SUGGESTED" ? 1 : 2);
  const open = ordered.filter((item) => !isDone(item.status));
  if (open.length === 0) return null;
  const best = Math.min(...open.map((item) => rank(item.status)));
  return open.find((item) => rank(item.status) === best)!.id;
}

/** The three parts of the work, and which one is current: describe the study, check the answers, confirm. */
export type QuestionsStage = "describe" | "check" | "confirm" | "done";
export function questionsStage(counts: { total: number; answered: number; assumed: number; suggested: number }, confirmed: boolean): QuestionsStage {
  const done = counts.answered + counts.assumed;
  if (confirmed) return "done";
  if (done >= counts.total) return "confirm";
  if (done === 0 && counts.suggested === 0) return "describe";
  return "check";
}

export function groupByCategory<T extends Pick<ChecklistItem, "category" | "categoryName">>(items: T[]): Array<{ category: string; name: string; items: T[] }> {
  const groups: Array<{ category: string; name: string; items: T[] }> = [];
  for (const item of items) {
    let group = groups.find((entry) => entry.category === item.category);
    if (!group) {
      group = { category: item.category, name: item.categoryName, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function progressLine(answered: number, total: number, assumed = 0): string {
  return assumed > 0 ? `${answered - assumed} answered and ${assumed} assumed, out of ${total}` : `${answered} of ${total} answered`;
}

/** The sentence that says what Publish needs, in every mode. */
export const PUBLISH_NEEDS_LINE =
  "Publishing needs every question answered or marked as an assumption. Suggested answers do not count until you accept them, and neither do questions marked Not decided or Conflict.";

/** "From your text" or "Assistant's guess" for a row the assistant wrote or that came from one. */
export function originLabel(item: Pick<ChecklistItem, "evidenceClass" | "sourceNote" | "status">): string | null {
  if (item.status === "SUGGESTED" || ((item.status === "ANSWERED" || item.status === "ASSUMED") && item.sourceNote)) {
    return item.evidenceClass === "fact" ? "From your text" : item.evidenceClass === "assumption" ? "Assistant's guess" : null;
  }
  return null;
}

/** Who gave an answer, in one short line under the status tag. */
export function answeredByLine(item: Pick<ChecklistItem, "status" | "confirmedByName" | "confirmedAt" | "sourceNote">): string | null {
  if (item.status !== "ANSWERED" && item.status !== "ASSUMED") return null;
  if (!item.confirmedAt && !item.confirmedByName) return "Earlier answer (not checked)";
  const who = item.confirmedByName ?? "A team member";
  const when = formatDate(item.confirmedAt);
  return `${item.sourceNote ? "Accepted from the assistant by" : "Answered by"} ${who}${when ? `, ${when}` : ""}`;
}

/** The position of a question inside its group, for a label that means something to a person. */
export function questionLabel(items: Array<Pick<ChecklistItem, "id" | "category" | "categoryName">>, id: string): string {
  const item = items.find((entry) => entry.id === id);
  if (!item) return "this question";
  const same = items.filter((entry) => entry.category === item.category);
  return `${item.categoryName}, question ${same.findIndex((entry) => entry.id === id) + 1}`;
}

/** What "Ask me the open questions" should say when there is nothing to ask. */
export function nothingToAskLine(counts: { suggested: number }): string {
  return counts.suggested > 0
    ? `${plural(counts.suggested, "suggestion is", "suggestions are")} waiting for you to check. Use the list above to accept or edit ${counts.suggested === 1 ? "it" : "them"}.`
    : "Nothing is open. Every question has an answer a person gave or accepted.";
}

/** Read-only members: what is still open for the team. */
export function openForTeamLine(openCount: number): string | null {
  return openCount > 0 ? `${plural(openCount, "question still needs", "questions still need")} a study lead.` : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "The assistant suggested 14 answers, could not find 12, and found 3 that disagree." */
export function draftResultLine(summary: { suggested: number; unknown: number; conflicts: number; unchanged?: number; replaced?: number }): string {
  const parts = [`suggested ${plural(summary.suggested, "answer", "answers")}`, `could not find ${summary.unknown}`];
  const tail = summary.conflicts === 1 ? "found 1 that disagrees" : `found ${summary.conflicts} that disagree`;
  const text = `The assistant ${parts.join(", ")}, and ${tail}.`;
  const kept = summary.unchanged ? ` ${plural(summary.unchanged, "answer", "answers")} you already gave or marked ${summary.unchanged === 1 ? "was" : "were"} left as ${summary.unchanged === 1 ? "it is" : "they are"}.` : "";
  const replaced = summary.replaced ? ` ${plural(summary.replaced, "earlier suggestion was", "earlier suggestions were")} replaced.` : "";
  return `${text}${kept}${replaced}`;
}

export function acceptAllLine(count: number, guesses = 0): string {
  const split = count > 0 ? ` ${count - guesses} ${count - guesses === 1 ? "is" : "are"} from your text and ${guesses} ${guesses === 1 ? "is a guess" : "are guesses"}.` : "";
  return `Accept ${plural(count, "suggestion", "suggestions")}?${split} You are saying you have checked ${count === 1 ? "it" : "them"} and the answer${count === 1 ? " is" : "s are"} right. Guesses become assumptions: answers you go ahead with without being sure.`;
}

/** Shorten long answers for the table; the full text is one click away. */
export function truncateAnswer(text: string, max = 160): { text: string; truncated: boolean } {
  const value = text.trim();
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max).trimEnd()}…`, truncated: true };
}

/** Which row actions make sense for a status. */
export function rowActions(status: ChecklistStatus, hasAnswer: boolean): { edit: boolean; accept: boolean; assume: boolean; unknown: boolean } {
  return {
    edit: true,
    accept: status === "SUGGESTED" && hasAnswer,
    assume: status !== "ASSUMED" && hasAnswer,
    unknown: status !== "UNKNOWN"
  };
}

/** The card gives back an option id or the person's own words. Save the words the person saw. */
export function answerTextFor(question: PlanQuestion, value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value.join("; ") : (value ?? "");
  const option = question.options.find((entry) => entry.id === first);
  return (option?.label ?? first).trim();
}

export type ConfirmState = { enabled: boolean; reason: string | null };

/** The confirm button is on only when nothing needs the person. */
export function confirmState(counts: { total: number; answered: number; assumed: number }, canEdit: boolean): ConfirmState {
  const left = counts.total - counts.answered - counts.assumed;
  if (!canEdit) return { enabled: false, reason: "You can read the answers but not confirm them." };
  if (left > 0) return { enabled: false, reason: `${plural(left, "question still needs", "questions still need")} you.` };
  return { enabled: true, reason: null };
}

export function confirmedLine(name: string | null, at: string | null): string {
  const when = formatDate(at);
  return `Confirmed by ${name ?? "a study lead"}${when ? ` on ${when}` : ""}`;
}
