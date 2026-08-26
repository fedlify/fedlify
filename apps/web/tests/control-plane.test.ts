import { beforeEach, describe, expect, it } from "vitest";
import {
  allowedTransitions,
  assertTransition,
  canonicalJson,
  classifyEvidence,
  contentHash,
  hasCredentialMaterial,
  metadataForPersistence,
  redactSecrets,
  signControlPayload
} from "@/lib/control-plane";

describe("v3 control plane", () => {
  beforeEach(() => {
    process.env.FEDLIFY_CONTROL_SIGNING_SECRET = "unit-test-secret-that-is-long-enough";
  });

  it("uses stable canonical hashes and signatures", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(contentHash({ b: 2, a: 1 })).toBe(contentHash({ a: 1, b: 2 }));
    expect(signControlPayload({ a: 1 })).toHaveLength(64);
  });

  it("allows only the mandatory lifecycle path", () => {
    expect(allowedTransitions.INTAKE).toContain("CLASSIFIED");
    expect(() => assertTransition("INTAKE", "HUMAN_APPROVED")).toThrow("Invalid control-plane transition");
    expect(() => assertTransition("SEMANTIC_VERIFIED", "HUMAN_APPROVED")).not.toThrow();
  });

  it("quarantines raw or sensitive evidence", () => {
    expect(
      classifyEvidence({
        sourceType: "upload",
        sourceLocator: "local",
        sourceVersion: "1",
        contentHash: "a".repeat(64),
        filename: "patients.csv",
        containsSensitive: false,
        metadata: { fixtureContent: "patientunitstayid,age\n1001,72" }
      }).classification
    ).toBe("QUARANTINED");
  });

  it("permits versioned aggregate CSV evidence without row identifiers", () => {
    expect(classifyEvidence({
      sourceType: "upload",
      sourceLocator: "local",
      sourceVersion: "1",
      contentHash: "b".repeat(64),
      filename: "aggregate.csv",
      containsSensitive: false,
      metadata: { fixtureContent: "site,n_stays,mortality_pct\nA,2186,7.57" }
    }).classification).toBe("CURATED");
  });

  it("does not curate expired evidence", () => {
    expect(classifyEvidence({
      sourceType: "upload",
      sourceLocator: "evidence://expired",
      sourceVersion: "1",
      freshnessExpiresAt: new Date("2020-01-01T00:00:00Z"),
      contentHash: "c".repeat(64),
      filename: "aggregate.json",
      containsSensitive: false,
      metadata: { summary: "aggregate evidence only" }
    })).toMatchObject({ classification: "UNTRUSTED", reasonCodes: ["STALE_EVIDENCE"] });
  });

  it("redacts credential material before persistence or export", () => {
    expect(redactSecrets("authorization: Bearer super-secret")).toContain("[REDACTED]");
    expect(hasCredentialMaterial({ token: "top-secret-value" })).toBe(true);
    expect(hasCredentialMaterial({ result: "safe" })).toBe(false);
  });

  it("persists evidence descriptors and hashes instead of prompts or content", () => {
    const persisted = metadataForPersistence({ source: "registry", fixtureContent: "raw row", nested: { prompt: "do something" } });
    expect(persisted).toMatchObject({
      source: "registry",
      fixtureContent: { redacted: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      nested: { prompt: { redacted: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) } }
    });
    expect(JSON.stringify(persisted)).not.toContain("raw row");
    expect(JSON.stringify(persisted)).not.toContain("do something");
  });
});
