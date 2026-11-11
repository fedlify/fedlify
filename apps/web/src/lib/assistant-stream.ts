/**
 * Client-side helpers for the read-only project assistant stream (POST .../agent/messages).
 * Pure functions so the SSE handling can be unit tested without a browser.
 */

import { THREAD_SSE_EVENTS, type PlanEventData, type QuestionsEventData, type StopEventData, type TurnEventData } from "@/lib/agent-thread-types";

export type AssistantEvent =
  | { kind: "context"; hash: string; commit: string | null; truncated: string[]; answered: number; total: number }
  | { kind: "delta"; text: string }
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done" }
  | { kind: "turn"; data: TurnEventData }
  | { kind: "questions"; data: QuestionsEventData }
  | { kind: "plan"; data: PlanEventData }
  | { kind: "stop"; data: StopEventData }
  | { kind: "ignore" };

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const MAX_HISTORY_TURNS = 20;
export const MAX_TURN_CHARS = 20000;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_SELECTION_CHARS = 20000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Thread events carry their fields either flat next to "type" or under "data". */
function threadEventData(event: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(event.data) ?? event;
}

/** Map one decoded SSE JSON payload to something the panel can act on. Unknown events are ignored. */
export function interpretEvent(payload: unknown): AssistantEvent {
  const event = asRecord(payload);
  const type = typeof event?.type === "string" ? event.type : "";
  if (!event) return { kind: "ignore" };
  switch (type) {
    case "fedlify.context":
      return {
        kind: "context",
        hash: typeof event.hash === "string" ? event.hash : "",
        commit: typeof event.commit === "string" ? event.commit : null,
        truncated: Array.isArray(event.truncated) ? event.truncated.filter((item): item is string => typeof item === "string") : [],
        answered: typeof event.requirementsAnswered === "number" ? event.requirementsAnswered : 0,
        total: typeof event.requirementsTotal === "number" ? event.requirementsTotal : 0
      };
    case "response.output_text.delta":
      return typeof event.delta === "string" && event.delta ? { kind: "delta", text: event.delta } : { kind: "ignore" };
    case "fedlify.notice":
      return { kind: "notice", message: typeof event.message === "string" ? event.message : "The reply was cut short." };
    case "fedlify.error":
      return { kind: "error", message: typeof event.message === "string" ? event.message : "The assistant failed." };
    case "fedlify.done":
      return { kind: "done" };
    case THREAD_SSE_EVENTS.turn: {
      const data = threadEventData(event);
      return data && typeof data.userTurnId === "string" && typeof data.assistantTurnId === "string"
        ? { kind: "turn", data: data as unknown as TurnEventData }
        : { kind: "ignore" };
    }
    case THREAD_SSE_EVENTS.questions: {
      const data = threadEventData(event);
      return data && asRecord(data.payload) && Array.isArray(asRecord(data.payload)?.questions)
        ? { kind: "questions", data: data as unknown as QuestionsEventData }
        : { kind: "ignore" };
    }
    case THREAD_SSE_EVENTS.plan: {
      const data = threadEventData(event);
      return data && asRecord(data.plan) ? { kind: "plan", data: data as unknown as PlanEventData } : { kind: "ignore" };
    }
    case THREAD_SSE_EVENTS.stop: {
      const data = threadEventData(event);
      const stop = asRecord(data?.stop);
      return data && stop && typeof stop.code === "string" && typeof stop.title === "string"
        ? { kind: "stop", data: data as unknown as StopEventData }
        : { kind: "ignore" };
    }
    default:
      return { kind: "ignore" };
  }
}

/** Incremental SSE parser: feed decoded text chunks, get events back. Tolerates split lines and CRLF. */
export function createSseParser() {
  let buffer = "";
  const handleLine = (line: string, out: AssistantEvent[]) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = interpretEvent(JSON.parse(data));
      if (event.kind !== "ignore") out.push(event);
    } catch {
      // Not JSON; nothing to show.
    }
  };
  return {
    push(chunk: string): AssistantEvent[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const out: AssistantEvent[] = [];
      lines.forEach((line) => handleLine(line, out));
      return out;
    },
    flush(): AssistantEvent[] {
      const out: AssistantEvent[] = [];
      handleLine(buffer, out);
      buffer = "";
      return out;
    }
  };
}

/** Prior turns to send back: only completed, non-empty turns, bounded in count and size. */
export function buildHistory(turns: Array<ChatTurn & { status?: string }>): ChatTurn[] {
  return turns
    .filter((turn) => turn.content.trim() && (turn.status === undefined || turn.status === "done"))
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) }));
}

/** Split reply text into plain text and fenced code blocks so it can be rendered without HTML injection. */
export function splitFences(text: string): Array<{ type: "text" | "code"; value: string }> {
  const parts: Array<{ type: "text" | "code"; value: string }> = [];
  const fence = /```[^\n]*\n([\s\S]*?)(```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: "code", value: match[1].replace(/\n$/, "") });
    last = match.index + match[0].length;
    if (match[0].length === 0) fence.lastIndex++;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
