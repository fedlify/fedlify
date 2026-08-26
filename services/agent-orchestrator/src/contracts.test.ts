import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { coordinatorAdvisorySchema, verifySignature } from "./contracts.js";
import { profileFromEnvironment } from "./providers.js";

describe("signed work items", () => {
  it("rejects forged payloads", () => {
    process.env.FEDLIFY_CONTROL_SIGNING_SECRET = "test-secret";
    const payload = { a: 1 };
    const signature = createHmac("sha256", "test-secret").update('{"a":1}').digest("hex");
    expect(verifySignature(payload, signature)).toBe(true);
    expect(verifySignature({ a: 2 }, signature)).toBe(false);
  });
});

describe("coordinator advice", () => {
  it("contains requirements and no authoritative layer", () => {
    const advisory = coordinatorAdvisorySchema.parse({
      intent: "STUDY_PREPARATION", requirementIds: ["R01", "R20"], riskSignals: ["EVIDENCE_GAP"],
      requiredCapabilities: ["protocol drafting"], clarificationQuestions: [], confidence: 0.9, rationale: "Bounded preparation."
    });
    expect(advisory.requirementIds).toEqual(["R01", "R20"]);
    expect(advisory).not.toHaveProperty("layer");
    expect(() => coordinatorAdvisorySchema.parse({
      intent: "OTHER", requirementIds: ["R30"], riskSignals: [], requiredCapabilities: [],
      clarificationQuestions: [], confidence: 1, rationale: "invalid"
    })).toThrow();
  });
});

describe("provider profiles", () => {
  it("preserves the explicitly configured hosted model without fallback", () => {
    process.env.FEDLIFY_HOSTED_MODEL = "gpt-5.6-sol";
    process.env.FEDLIFY_HOSTED_REASONING_EFFORT = "high";
    expect(profileFromEnvironment("hosted")).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "high" });
  });

  it("omits reasoning effort for a model that doesn't support it, rather than forcing a default", () => {
    process.env.FEDLIFY_HOSTED_MODEL = "gpt-4.1";
    delete process.env.FEDLIFY_HOSTED_REASONING_EFFORT;
    expect(profileFromEnvironment("hosted")).toMatchObject({ model: "gpt-4.1", reasoningEffort: undefined });
  });

  it("keeps the local provider independently configurable", () => {
    process.env.FEDLIFY_LOCAL_MODEL_NAME = "local-eval-model";
    process.env.FEDLIFY_LOCAL_MODEL_BASE_URL = "http://127.0.0.1:11434/v1";
    expect(profileFromEnvironment("local")).toMatchObject({ provider: "openai-compatible", model: "local-eval-model" });
  });

  it("rejects unknown profiles instead of falling back", () => {
    expect(() => profileFromEnvironment("automatic-fallback")).toThrow("Unknown provider profile");
  });
});
