import { describe, expect, it } from "vitest";
import { buildNvflareJobId, submitNvflareJob } from "@/lib/nvflare";

describe("nvflare wrapper", () => {
  it("derives stable Fedlify-controlled job ids", () => {
    expect(buildNvflareJobId("clxabcdefghijklmnopqrstuvwxyz")).toBe("fedlify-clxabcdefghi");
  });

  it("submits through the wrapper contract", async () => {
    const result = await submitNvflareJob({
      fedlifyJobId: "clxabcdefghijklmnopqrstuvwxyz",
      pipelineVersionId: "pipeline-version-1",
      selectedSiteCodes: ["uhn", "sickkids"],
      deployment: {
        id: "deployment-1",
        serverAddress: "localhost:18000",
        adminStartupKitStorageKey: "studies/study/deployments/deployment/admin-kit.zip"
      },
      gitCommit: "abc123",
      runtimeParameters: { numClients: 2, minClients: 2, numRounds: 3 }
    });

    expect(result.status).toBe("SUBMITTED");
    expect(result.summary).toContain("localhost:18000");
    expect(result.summary).toContain("2 site");
    expect(result.summary).toContain("min_clients=2");
    expect(result.summary).toContain("num_rounds=3");
  });
});
