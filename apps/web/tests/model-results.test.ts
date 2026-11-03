import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  collectModelResultArtifacts,
  collectModelResultArtifactsFromStorage,
  nextModelReleaseVersion,
  parseNpyMetadata,
  resultPathAvailable
} from "@/lib/model-results";

const storedObjects = new Map<string, Buffer>();
vi.mock("@/lib/storage", () => ({
  objectKey: (parts: string[]) => parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"),
  readObject: async (key: string) => {
    const body = storedObjects.get(key);
    if (!body) throw new Error(`NoSuchKey: ${key}`);
    return body;
  }
}));

function sha256Hex(body: Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

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

  it("parses a one-dimensional numpy shape without a phantom dimension", () => {
    const header = "{'descr': '<f8', 'fortran_order': False, 'shape': (28,), }\n";
    const length = Buffer.alloc(2);
    length.writeUInt16LE(header.length, 0);
    const buffer = Buffer.concat([Buffer.from("\x93NUMPY", "latin1"), Buffer.from([1, 0]), length, Buffer.from(header)]);
    expect(parseNpyMetadata(buffer)?.shape).toEqual([28]);
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

  it("reports whether the local result directory still holds the aggregated model", async () => {
    expect(await resultPathAvailable(null)).toBe(false);
    expect(await resultPathAvailable(path.join(os.tmpdir(), "fedlify-does-not-exist"))).toBe(false);
    const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-model-result-test-"));
    try {
      await mkdir(path.join(root, "workspace", "models"), { recursive: true });
      await writeFile(path.join(root, "workspace", "models", "server.npy"), npyHeaderBuffer());
      expect(await resultPathAvailable(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the result package from object storage and verifies the recorded checksums", async () => {
    const identity = { studyId: "study", jobId: "job", nvflareJobId: "nvflare-job", pipelineVersionId: "pv", storagePrefix: "studies/study/model-releases/model-v1.0.0" };
    const model = npyHeaderBuffer();
    const log = Buffer.from("completed");
    storedObjects.set("studies/study/nvflare-jobs/job/results/server.npy", model);
    storedObjects.set("studies/study/nvflare-jobs/job/results/log.txt", log);
    const stored = [
      { kind: "AGGREGATED_MODEL" as const, filename: "server.npy", contentType: "application/octet-stream", storageKey: "studies/study/nvflare-jobs/job/results/server.npy", checksum: sha256Hex(model) },
      { kind: "LOG" as const, filename: "log.txt", contentType: "text/plain", storageKey: "studies/study/nvflare-jobs/job/results/log.txt", checksum: sha256Hex(log) }
    ];

    const result = await collectModelResultArtifactsFromStorage({ ...identity, storedArtifacts: stored });
    expect(result.modelShape).toEqual([3, 3]);
    expect(result.resultPath).toBe("s3://studies/study/model-releases/model-v1.0.0");
    expect(result.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["AGGREGATED_MODEL", "LOG", "MANIFEST"]);

    // A stored object that no longer matches its sync-time checksum is refused.
    storedObjects.set("studies/study/nvflare-jobs/job/results/server.npy", Buffer.from("tampered"));
    await expect(collectModelResultArtifactsFromStorage({ ...identity, storedArtifacts: stored })).rejects.toThrow(/checksum/);

    // A missing aggregated model row is refused; a missing optional artifact is skipped.
    await expect(collectModelResultArtifactsFromStorage({ ...identity, storedArtifacts: [stored[1]] })).rejects.toThrow(/AGGREGATED_MODEL/);
  });
});

