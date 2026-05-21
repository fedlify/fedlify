import { describe, expect, it } from "vitest";
import { nextReleaseVersion, releaseChecksum } from "@/lib/release";

describe("release helpers", () => {
  it("increments immutable release versions", () => {
    expect(nextReleaseVersion([])).toBe("v1");
    expect(nextReleaseVersion(["v1", "v2"])).toBe("v3");
  });

  it("creates deterministic release checksums", () => {
    const checksum = releaseChecksum({
      studyId: "study",
      agentRunId: "agent",
      version: "v1",
      storagePrefix: "studies/study/releases/v1"
    });
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
