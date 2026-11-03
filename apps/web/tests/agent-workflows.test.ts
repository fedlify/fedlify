import { afterEach, describe, expect, it } from "vitest";
import { submitPipelineWorkflow } from "@/lib/agent";

describe("pipeline workflow submission", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses a deterministic local no-op outside Kubernetes", async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.FEDLIFY_PUBLIC_BASE_URL = "https://app.fedlify.test";

    const result = await submitPipelineWorkflow({
      pipelineVersionId: "version_ABC123",
      ciRunId: "ci_DEF456",
      studyId: "study-1",
      giteaOwner: "fedlify-study",
      giteaRepo: "pipeline",
      gitCommit: "abc123",
      gitopsPath: "studies/study-1/pipelines/pipeline"
    });

    expect(result).toEqual({
      workflowId: "fedlify-pipeline-version-abc123-ci-def456",
      submitted: false
    });
  });
});
