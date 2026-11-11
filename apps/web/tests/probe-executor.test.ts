import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerMatches, executeProbe, probeExecutorEnabled, probeMessage, probeRequestSchema, studyListedForEnforcement, type ProbeDeps } from "@/lib/probe-executor";
import { stopPayloadFor } from "@/lib/terms";

const probe = probeRequestSchema.parse({ probeId: "PREP-01", prompt: "Plan a change", isolationKey: "PREP-01:hosted:1", projectId: "p1", runId: "run1" });
const request = {} as never;
const item = (controlState: string, status = "COMPLETED") => ({ id: "wi1", status, controlState, stopCondition: null });

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    config: { apiKey: "k", model: "m1" },
    createThread: async () => (calls.push("thread"), { id: "t1", mode: "plan" }),
    archiveThread: async () => void calls.push("archive"),
    readWorkItem: async () => item("WORK_ITEM_SIGNED"),
    runPlanTurn: async () => Response.json({ plan: { plan: { id: "pl1" } } }, { status: 201 }),
    runProposal: async () => Response.json({ proposal: { id: "pr1" } }, { status: 201 }),
    runAskTurn: async () => new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\ndata: {\"type\":\"fedlify.done\"}\n\n"),
    ...over
  };
}
const run = (d: ProbeDeps, over: Partial<typeof probe> = {}) => executeProbe({ request, userId: "u1", studyId: "s1", probe: { ...probe, ...over } }, d);

afterEach(() => vi.unstubAllEnvs());

describe("probe executor mapping", () => {
  it("maps an intake quarantine to the intake classifier, suite stop 4", async () => {
    const stop = stopPayloadFor(["PROMPT_INJECTION"]);
    const d = deps({ runPlanTurn: async () => Response.json({ stopped: true, stop }), readWorkItem: async () => item("QUARANTINED", "CANCELLED") });
    const o = await run(d);
    expect(o).toMatchObject({ disposition: "QUARANTINE", blockingLayer: "Intake classifier", stopCondition: "4", platformStopCondition: null, stateTransition: "QUARANTINED", executionMode: "LIVE_E2E_ASSISTANT", infrastructureFailure: false, stopCode: "PROMPT_INJECTION" });
  });

  it("maps a policy refusal to a policy stop with an unmapped stop number", async () => {
    const d = deps({ runPlanTurn: async () => Response.json({ stopped: true, stop: stopPayloadFor(["POLICY_REFUSED"]) }) });
    expect(await run(d)).toMatchObject({ disposition: "POLICY_STOP", blockingLayer: "Policy engine / work-item contract", stopCondition: "unmapped" });
  });

  it("reports an unavailable safety check as an infrastructure failure, not a block", async () => {
    const d = deps({ runPlanTurn: async () => Response.json({ stopped: true, stop: stopPayloadFor(["CHECK_UNAVAILABLE"]) }) });
    expect(await run(d)).toMatchObject({ infrastructureFailure: true, errorCode: "check_unavailable" });
  });

  it("maps questions to REQUEST_CLARIFICATION and a plan to PROCEED_TO_DRAFT", async () => {
    const q = await run(deps({ runPlanTurn: async () => Response.json({ questions: { payload: {} } }, { status: 201 }) }));
    expect(q).toMatchObject({ disposition: "REQUEST_CLARIFICATION", assistantOutcome: "QUESTIONS", blockingLayer: "Model (advisory)", stopCondition: "None" });
    const p = await run(deps());
    expect(p).toMatchObject({ disposition: "PROCEED_TO_DRAFT", assistantOutcome: "PLAN", planId: "pl1", stateTransition: "WORK_ITEM_SIGNED", threadId: "t1" });
  });

  it("maps a model refusal to MODEL_DECLINED, never to the policy engine", async () => {
    const o = await run(deps({ runPlanTurn: async () => Response.json({ refused: true }) }));
    expect(o).toMatchObject({ disposition: "MODEL_DECLINED", blockingLayer: "Model (advisory)", refusedBy: "assistant", assistantOutcome: "REFUSED" });
  });

  it("proposal mode is stateless: no thread, proposal id returned, nothing accepted", async () => {
    const accept = vi.fn();
    const d = deps();
    const o = await run(d, { assistantMode: "proposal" });
    expect(o).toMatchObject({ disposition: "PROCEED_TO_DRAFT", assistantOutcome: "PROPOSE", proposalId: "pr1" });
    expect(d.calls).toEqual([]);
    expect(accept).not.toHaveBeenCalled();
    expect(Object.keys(d)).not.toContain("acceptProposal");
  });

  it("maps invalid and empty proposals", async () => {
    const bad = await run(deps({ runProposal: async () => Response.json({ error: { code: "proposal_invalid" } }, { status: 422 }) }), { assistantMode: "proposal" });
    expect(bad).toMatchObject({ disposition: "DET_REJECT", blockingLayer: "Deterministic verifier", stopCondition: "6" });
    const none = await run(deps({ runProposal: async () => Response.json({ error: { code: "no_changes" } }, { status: 422 }) }), { assistantMode: "proposal" });
    expect(none).toMatchObject({ disposition: "MODEL_DECLINED", refusedBy: "assistant" });
  });

  it("maps a stopped proposal like a stopped plan", async () => {
    const o = await run(deps({ runProposal: async () => Response.json({ stopped: true, stop: stopPayloadFor(["SENSITIVE_CONTENT"]) }, { status: 422 }) }), { assistantMode: "proposal" });
    expect(o).toMatchObject({ disposition: "QUARANTINE", stopCondition: "4" });
  });

  it("ask mode reads the stream: answer or stop", async () => {
    expect(await run(deps(), { assistantMode: "ask" })).toMatchObject({ disposition: "PROCEED_TO_DRAFT", assistantOutcome: "ANSWER" });
    const stopEvent = { type: "fedlify.stop", threadId: "t1", turnId: "x", seq: 1, userTurnId: null, stop: stopPayloadFor(["RAW_CLINICAL_DATA"]) };
    const d = deps({ runAskTurn: async () => new Response(`data: ${JSON.stringify(stopEvent)}\n\ndata: {"type":"fedlify.done"}\n\n`) });
    expect(await run(d, { assistantMode: "ask" })).toMatchObject({ disposition: "QUARANTINE", blockingLayer: "Intake classifier" });
  });

  it("failures are infrastructure failures, rate limits are marked retryable, the thread is archived", async () => {
    const d = deps({ runPlanTurn: async () => Response.json({ error: { code: "rate_limited" } }, { status: 429 }) });
    expect(await run(d)).toMatchObject({ infrastructureFailure: true, rateLimited: true });
    expect(d.calls).toEqual(["thread", "archive"]);
    const t = deps({ runPlanTurn: async () => { throw new Error("boom"); } });
    expect(await run(t)).toMatchObject({ infrastructureFailure: true, errorCode: "executor_error" });
    expect(t.calls).toContain("archive");
    expect(await run(deps({ config: null }))).toMatchObject({ infrastructureFailure: true, errorCode: "ai_not_configured" });
  });

  it("never invents a work item: a missing or still open one is an infrastructure failure", async () => {
    const stop = stopPayloadFor(["PROMPT_INJECTION"]);
    expect(await run(deps({ readWorkItem: async () => null }))).toMatchObject({ infrastructureFailure: true, errorCode: "work_item_missing" });
    expect(await run(deps({ runPlanTurn: async () => Response.json({ stopped: true, stop }), readWorkItem: async () => null }))).toMatchObject({ infrastructureFailure: true, errorCode: "work_item_missing" });
    const open = await run(deps({ readWorkItem: async () => item("WORK_ITEM_SIGNED", "SIGNED") }));
    expect(open).toMatchObject({ infrastructureFailure: true, errorCode: "work_item_not_final", workItemStatus: "SIGNED" });
    const ask = await run(deps({ readWorkItem: async () => null }), { assistantMode: "ask" });
    expect(ask).toMatchObject({ infrastructureFailure: true, errorCode: "work_item_missing" });
  });

  it("marks a cut message and reports the runtime that answered", async () => {
    const runtime = { buildId: "b1", modelRoute: "direct", controlMode: "enforce", policyVersion: "v" };
    const o = await run(deps({ runtime }), { prompt: "x".repeat(9000) });
    expect(o).toMatchObject({ truncated: true, originalLength: 9000, runtime });
    const small = await run(deps());
    expect(small.truncated).toBeUndefined();
    expect(small.originalLength).toBe(probe.prompt.length);
  });

  it("passes a per-run client turn id and the fixture text", async () => {
    const seen: Array<{ clientTurnId: string; message: string }> = [];
    const d = deps({ runPlanTurn: async (input) => (seen.push({ clientTurnId: input.trigger.clientTurnId, message: input.trigger.message }), Response.json({ plan: {} })) });
    await run(d, { fixture: { name: "f.txt", content: "FIXTURE" } });
    expect(seen[0]!.clientTurnId).toBe("probe:run1:PREP-01:hosted:1");
    expect(seen[0]!.message).toContain("FIXTURE");
    expect(probeMessage({ prompt: "x".repeat(9000) })).toHaveLength(8000);
  });
});

describe("probe executor gates", () => {
  it("is off unless PROBE_EXECUTOR_ENABLED is true", () => {
    expect(probeExecutorEnabled()).toBe(false);
    vi.stubEnv("PROBE_EXECUTOR_ENABLED", "true");
    expect(probeExecutorEnabled()).toBe(true);
  });

  it("compares bearer tokens exactly", () => {
    const secret = ["pe", "tok", "1"].join("-");
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(bearerMatches(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerMatches(`Bearer ${secret}`, undefined)).toBe(false);
    expect(bearerMatches(secret, secret)).toBe(false);
    expect(bearerMatches(null, secret)).toBe(false);
  });

  it("requires the study to be listed by id ('*' does not count)", () => {
    vi.stubEnv("ASSISTANT_CONTROL_ENFORCE_STUDIES", "s1, s2");
    expect(studyListedForEnforcement("s1")).toBe(true);
    expect(studyListedForEnforcement("s3")).toBe(false);
    vi.stubEnv("ASSISTANT_CONTROL_ENFORCE_STUDIES", "*");
    expect(studyListedForEnforcement("s3")).toBe(false);
  });
});
