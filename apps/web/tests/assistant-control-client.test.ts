import { describe, expect, it } from "vitest";
import {
  approvalLabel,
  cleanReason,
  isEnforced,
  isWithheldNote,
  publishRefusalText,
  readVerification,
  reasonNote,
  reasonRequired,
  secondCheckView,
  shouldRequestVerify,
  stopFromPayload,
  validReason
} from "@/lib/assistant-control-client";
import { buildChatItems, initialStream, reduceStream, toThreadView } from "@/lib/agent-thread-client";
import { createSseParser, interpretEvent } from "@/lib/assistant-stream";
import { STOP_TEXT, stopPayloadFor, withheldNote } from "@/lib/terms";
import type { TurnDto } from "@/lib/agent-thread-types";

function turn(partial: Partial<TurnDto>): TurnDto {
  return {
    id: "t1", threadId: "th", seq: 1, role: "ASSISTANT", kind: "MESSAGE", content: "", payload: null, status: "done", actorUserId: null, model: null,
    promptVersion: null, contextHash: null, baseCommit: null, filePath: null, selection: null, clientTurnId: null, planId: null, proposalId: null, createdAt: "2026-01-01T00:00:00Z",
    ...partial
  };
}

describe("paused notices", () => {
  it("reads a stop payload and fills missing text from the shared wording", () => {
    const stop = stopFromPayload({ stop: { code: "SENSITIVE_CONTENT", title: "Paused" } });
    expect(stop?.code).toBe("SENSITIVE_CONTENT");
    expect(stop?.why).toBe(STOP_TEXT.SENSITIVE_CONTENT.why);
    expect(stopFromPayload({ planId: "p" })).toBeNull();
    expect(stopFromPayload(null)).toBeNull();
  });

  it("maps an unknown code to the policy stop", () => {
    expect(stopFromPayload({ stop: { code: "SOMETHING_NEW", title: "x" } })?.code).toBe("POLICY_REFUSED");
  });

  it("renders a NOTICE with a stop as a stop item and a withheld user message as withheld", () => {
    const stop = stopPayloadFor(["SENSITIVE_CONTENT"]);
    const items = buildChatItems(
      [turn({ id: "u", seq: 1, role: "USER", content: withheldNote("SENSITIVE_CONTENT") }), turn({ id: "n", seq: 2, kind: "NOTICE", content: "x", payload: { stop } })],
      []
    );
    expect(items[0]).toMatchObject({ type: "message", withheld: true });
    expect(items[1]).toMatchObject({ type: "stop", turnId: "n" });
    expect(isWithheldNote(withheldNote("PROMPT_INJECTION"))).toBe(true);
  });

  it("leaves ordinary notices and messages as they were", () => {
    const items = buildChatItems([turn({ id: "n", kind: "NOTICE", content: "hello" }), turn({ id: "u", seq: 2, role: "USER", content: "hi" })], []);
    expect(items[0]).toEqual({ type: "message", key: "n", role: "assistant", content: "hello", status: "done", isNotice: true, turnId: "n" });
    expect(items[1]).not.toHaveProperty("withheld");
  });

  it("understands the stop stream event and ends the stream cleanly", () => {
    const stop = stopPayloadFor(["CHECK_UNAVAILABLE"]);
    const parser = createSseParser();
    const events = parser.push(`data: ${JSON.stringify({ type: "fedlify.stop", threadId: "th", turnId: "n", seq: 2, userTurnId: null, stop })}\n\ndata: {"type":"fedlify.done"}\n\n`);
    expect(events.map((event) => event.kind)).toEqual(["stop", "done"]);
    let state = initialStream();
    for (const event of events) state = reduceStream(state, event);
    expect(state.status).toBe("done");
    expect(state.stop?.code).toBe("CHECK_UNAVAILABLE");
    expect(state.assistantTurnId).toBe("n");
    expect(state.userTurnId).toBeUndefined();
    expect(interpretEvent({ type: "fedlify.stop", stop: {} })).toEqual({ kind: "ignore" });
  });
});

describe("second check", () => {
  it("is only used in enforced studies", () => {
    expect(isEnforced({}, undefined)).toBe(false);
    expect(isEnforced({ verificationStatus: null }, undefined)).toBe(true);
    expect(isEnforced({}, "enforce")).toBe(true);
    expect(reasonRequired(false, "CONCERNS")).toBe(false);
  });

  it("asks for a reason unless the check passed", () => {
    expect(reasonRequired(true, "PASSED")).toBe(false);
    for (const status of ["CONCERNS", "UNAVAILABLE", "CHECKING", null] as const) expect(reasonRequired(true, status)).toBe(true);
  });

  it("requests the check once for open items that have no result", () => {
    expect(shouldRequestVerify(true, null, true)).toBe(true);
    expect(shouldRequestVerify(true, "CHECKING", true)).toBe(true);
    expect(shouldRequestVerify(true, "PASSED", true)).toBe(false);
    expect(shouldRequestVerify(true, "UNAVAILABLE", true)).toBe(false);
    expect(shouldRequestVerify(false, null, true)).toBe(false);
    expect(shouldRequestVerify(true, null, false)).toBe(false);
  });

  it("describes each state in plain words", () => {
    expect(secondCheckView(null).label).toBe("Checking…");
    expect(secondCheckView("PASSED").label).toBe("Second check passed");
    const concerns = secondCheckView("CONCERNS", [{ kind: "beyond_request", text: "Adds a new file." }]);
    expect(concerns.label).toBe("Second check found things to look at");
    expect(concerns.findings).toHaveLength(1);
    expect(concerns.showAdvice).toBe(true);
    const down = secondCheckView("UNAVAILABLE");
    expect(down.label).toBe("Could not check: needs your decision");
    expect(down.canRetry).toBe(true);
    expect(secondCheckView("PASSED", [], true).checking).toBe(true);
  });

  it("reads the verify answer and drops anything unexpected", () => {
    expect(readVerification({ verification: { status: "CONCERNS", findings: [{ kind: "contradiction", text: "a" }, { nope: 1 }], ruleCheck: "FAILED", cached: false } })).toEqual({
      status: "CONCERNS",
      findings: [{ kind: "contradiction", text: "a" }],
      ruleCheck: "FAILED"
    });
    expect(readVerification({ verification: { status: "WEIRD" } })).toBeNull();
    expect(readVerification(null)).toBeNull();
  });

  it("has a sentence for the reason dialog", () => {
    expect(reasonNote("CONCERNS")).toContain("things to look at");
    expect(reasonNote("UNAVAILABLE")).toContain("could not run");
    expect(reasonNote(null)).toContain("not finished");
  });
});

describe("reason and approval wording", () => {
  it("needs at least 10 characters and keeps at most 500", () => {
    expect(validReason("too short")).toBe(false);
    expect(validReason("   long enough reason   ")).toBe(true);
    expect(cleanReason(` ${"a".repeat(600)} `)).toHaveLength(500);
  });

  it("says who approved and flags self-approval", () => {
    const base = { approvedById: "u", approvedByName: "Dr. Lee", selfApproved: false, valid: true, approvedAt: null };
    expect(approvalLabel(base)).toBe("Approved by Dr. Lee");
    expect(approvalLabel({ ...base, selfApproved: true })).toBe("Approved by Dr. Lee (self-approved)");
    expect(approvalLabel({ ...base, valid: false })).toContain("no longer applies");
    expect(approvalLabel(null)).toBe("");
  });

  it("shows the second approver refusal in the server's plain words", () => {
    expect(publishRefusalText("second_approver_required", "Dr. Lee can publish it.")).toBe("Dr. Lee can publish it.");
    expect(publishRefusalText("other", "x")).toBeNull();
  });
});

describe("thread view", () => {
  it("keeps controlMode only when enforced", () => {
    const thread = { id: "th" } as never;
    expect(toThreadView({ thread, controlMode: "enforce" }).controlMode).toBe("enforce");
    expect(toThreadView({ thread })).not.toHaveProperty("controlMode");
  });
});
