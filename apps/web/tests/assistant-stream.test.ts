import { describe, expect, it } from "vitest";
import { buildHistory, createSseParser, interpretEvent, splitFences } from "@/lib/assistant-stream";

const line = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe("assistant stream parsing", () => {
  it("maps known events and ignores the rest", () => {
    expect(interpretEvent({ type: "response.output_text.delta", delta: "Hi" })).toEqual({ kind: "delta", text: "Hi" });
    expect(interpretEvent({ type: "response.created" })).toEqual({ kind: "ignore" });
    expect(interpretEvent({ type: "fedlify.error", message: "boom" })).toEqual({ kind: "error", message: "boom" });
    expect(interpretEvent("nope")).toEqual({ kind: "ignore" });
    expect(interpretEvent({ type: "fedlify.context", hash: "h", commit: "c", truncated: ["a", 1], requirementsAnswered: 29, requirementsTotal: 29 })).toEqual({
      kind: "context", hash: "h", commit: "c", truncated: ["a"], answered: 29, total: 29
    });
  });

  it("reassembles events split across chunks and tolerates CRLF", () => {
    const parser = createSseParser();
    const whole = line({ type: "response.output_text.delta", delta: "Hello" }).replace(/\n/g, "\r\n");
    const events = [...parser.push(whole.slice(0, 20)), ...parser.push(whole.slice(20)), ...parser.push(line({ type: "fedlify.done" })), ...parser.flush()];
    expect(events).toEqual([{ kind: "delta", text: "Hello" }, { kind: "done" }]);
  });

  it("flushes a final line without a trailing newline and skips junk", () => {
    const parser = createSseParser();
    expect(parser.push("data: not json\n: comment\ndata: [DONE]\n")).toEqual([]);
    expect(parser.push('data: {"type":"fedlify.done"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: "done" }]);
  });

  it("only sends completed, bounded history", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: `m${i}`, status: "done" }));
    turns.push({ role: "assistant", content: "partial", status: "error" });
    turns.push({ role: "user", content: "   ", status: "done" });
    const history = buildHistory(turns);
    expect(history).toHaveLength(20);
    expect(history.at(-1)?.content).toBe("m29");
    expect(buildHistory([{ role: "user", content: "x".repeat(30000) }])[0].content).toHaveLength(20000);
  });

  it("splits fenced code, including an unterminated fence while streaming", () => {
    expect(splitFences("a\n```py\nx=1\n```\nb")).toEqual([
      { type: "text", value: "a\n" }, { type: "code", value: "x=1" }, { type: "text", value: "\nb" }
    ]);
    expect(splitFences("see\n```\nopen")).toEqual([{ type: "text", value: "see\n" }, { type: "code", value: "open" }]);
  });
});
