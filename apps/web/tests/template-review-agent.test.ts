import { describe, expect, it, vi } from "vitest";
import { validateTemplateRepositoryFiles } from "@/lib/pipeline-template-code";
import { toReviewSourceFiles } from "@/lib/source-review";
import { applyReviewChangesToFiles } from "@/lib/template-source";
import { isSafeReviewFilePath, normalizeReviewChangedFiles, runTemplateReviewAgent } from "@/lib/template-review-agent";

const sourceFiles = toReviewSourceFiles([
  { path: "README.md", content: "# Template\n" },
  {
    path: ".fedlify/template.json",
    content: JSON.stringify({
      packageType: "fedlify-nvflare-template",
      dataBoundary: "site-only",
      runtimeDefaults: { minClients: 2 }
    })
  },
  { path: "AGENTS.md", content: "Keep raw data out of this repo.\n" },
  { path: "nvflare-job/meta.conf", content: "name = \"template\"\n" },
  { path: "nvflare-job/app/config/config_fed_server.conf", content: "min_clients = 2\n" },
  { path: "nvflare-job/app/config/config_fed_client.conf", content: "executor = \"fedlify\"\n" },
  { path: "tests/test_template_manifest.py", content: "def test_manifest():\n    assert True\n" }
]);

describe("template review agent helpers", () => {
  it("rejects unsafe proposed file paths", () => {
    expect(isSafeReviewFilePath("README.md")).toBe(true);
    expect(isSafeReviewFilePath("../README.md")).toBe(false);
    expect(isSafeReviewFilePath(".git/config")).toBe(false);
    expect(isSafeReviewFilePath("/tmp/template.py")).toBe(false);
  });

  it("normalizes proposed file changes against source files", () => {
    const changes = normalizeReviewChangedFiles({
      sourceFiles,
      changedFiles: [
        { path: "README.md", proposedContent: "# Updated\n", reason: "Improve README" },
        { path: "../bad.py", proposedContent: "print('bad')" }
      ]
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "README.md",
      originalContent: "# Template\n",
      proposedContent: "# Updated\n"
    });
  });

  it("lets repository validation block prohibited raw-data paths in proposed changes", () => {
    const proposedFiles = applyReviewChangesToFiles(sourceFiles, [
      { path: "fixtures/raw-data.csv", proposedContent: "id,value\n1,2\n" }
    ]);
    const validation = validateTemplateRepositoryFiles(proposedFiles);

    expect(validation.status).toBe("FAILED");
    expect(validation.summary).toContain("prohibited data-like path");
  });

  it("reports a clear disabled state when OpenAI is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const result = await runTemplateReviewAgent({
      message: "Explain this file",
      selectedPath: "README.md",
      sourceRef: "current",
      files: sourceFiles
    });

    expect(result.aiConfigured).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.assistantMessage).toContain("OPENAI_API_KEY");
  });
});
