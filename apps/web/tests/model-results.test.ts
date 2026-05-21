import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectModelResultArtifacts, nextModelReleaseVersion, parseNpyMetadata } from "@/lib/model-results";

function npyHeaderBuffer() {
  const magic = Buffer.from("\x93NUMPY", "latin1");
  const version = Buffer.from([1, 0]);
  let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (3, 3), }";
  const headerLengthWithoutPadding = magic.length + version.length + 2 + header.length + 1;
  const padding = (16 - (headerLengthWithoutPadding % 16)) % 16;
  header = `${header}${" ".repeat(padding)}\n`;
  const length = Buffer.alloc(2);
  length.writeUInt16LE(Buffer.byteLength(header), 0);
  return Buffer.concat([magic, version, length, Buffer.from(header), Buffer.alloc(3 * 3 * 4)]);
}

describe("model result helpers", () => {
  it("increments model release versions separately from code releases", () => {
    expect(nextModelReleaseVersion([])).toBe("model-v1.0.0");
    expect(nextModelReleaseVersion(["v1", "model-v1.0.0", "model-v2.0.0"])).toBe("model-v3.0.0");
  });

  it("parses numpy model metadata", () => {
    expect(parseNpyMetadata(npyHeaderBuffer())).toEqual({ dtype: "<f4", shape: [3, 3] });
  });

  it("collects aggregated model, metrics, logs, metadata, and manifest artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-model-result-test-"));
    try {
      await mkdir(path.join(root, "workspace", "models"), { recursive: true });
      await writeFile(path.join(root, "workspace", "models", "server.npy"), npyHeaderBuffer());
      await writeFile(path.join(root, "workspace", "stats_pool_summary.json"), "{}");
      await writeFile(path.join(root, "workspace", "log.txt"), "completed");
      await writeFile(path.join(root, "workspace", "meta.json"), "{}");

      const result = await collectModelResultArtifacts({
        resultPath: root,
        studyId: "study",
        jobId: "job",
        nvflareJobId: "nvflare-job",
        pipelineVersionId: "pipeline-version",
        storagePrefix: "studies/study/nvflare-jobs/job/results"
      });

      expect(result.modelPath).toBe("workspace/models/server.npy");
      expect(result.modelShape).toEqual([3, 3]);
      expect(result.modelDtype).toBe("<f4");
      expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
        "AGGREGATED_MODEL",
        "LOG",
        "MANIFEST",
        "META",
        "METRICS"
      ]);
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

