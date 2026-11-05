import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { collectModelResultArtifacts, collectModelResultArtifactsFromStorage } from "@/lib/model-results";

const stored = new Map<string, Buffer>();
vi.mock("@/lib/storage", () => ({
  objectKey: (parts: string[]) => parts.join("/"),
  readObject: async (key: string) => {
    const b = stored.get(key);
    if (!b) throw new Error("NoSuchKey");
    return b;
  }
}));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ident = { studyId: "s", jobId: "j", nvflareJobId: "n", pipelineVersionId: "p", storagePrefix: "pre" };

describe("ROUND_METRICS artifact", () => {
  it("is found anywhere under the result dir and copied on the storage (promote) path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-rm-"));
    try {
      await mkdir(path.join(root, "workspace/models"), { recursive: true });
      await mkdir(path.join(root, "workspace/abc123"), { recursive: true });
      await writeFile(path.join(root, "workspace/models/server.npy"), "x");
      const jsonl = Buffer.from('{"event":"contribution","round":0,"site":"a","metrics":{"auroc":0.5}}\n');
      await writeFile(path.join(root, "workspace/abc123/fedlify_metrics.jsonl"), jsonl);
      const collected = await collectModelResultArtifacts({ ...ident, resultPath: root });
      const m = collected.artifacts.find((a) => a.kind === "ROUND_METRICS")!;
      expect(m.body.equals(jsonl)).toBe(true);
      expect(collected.manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ROUND_METRICS" })]));

      const model = collected.artifacts.find((a) => a.kind === "AGGREGATED_MODEL")!;
      stored.set("k/model", model.body);
      stored.set("k/metrics", m.body);
      const fromStorage = await collectModelResultArtifactsFromStorage({
        ...ident,
        storedArtifacts: [
          { kind: "AGGREGATED_MODEL", filename: "server.npy", contentType: "x", storageKey: "k/model", checksum: sha(model.body) },
          { kind: "ROUND_METRICS", filename: "fedlify_metrics.jsonl", contentType: "x", storageKey: "k/metrics", checksum: sha(m.body) }
        ]
      });
      expect(fromStorage.artifacts.find((a) => a.kind === "ROUND_METRICS")!.checksum).toBe(sha(jsonl));
      // a tampered metrics object is refused
      stored.set("k/metrics", Buffer.from("tampered"));
      await expect(
        collectModelResultArtifactsFromStorage({ ...ident, storedArtifacts: [
          { kind: "AGGREGATED_MODEL", filename: "server.npy", contentType: "x", storageKey: "k/model", checksum: sha(model.body) },
          { kind: "ROUND_METRICS", filename: "fedlify_metrics.jsonl", contentType: "x", storageKey: "k/metrics", checksum: sha(m.body) }
        ] })
      ).rejects.toThrow(/checksum/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("older results without the file still collect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-rm-"));
    try {
      await mkdir(path.join(root, "workspace/models"), { recursive: true });
      await writeFile(path.join(root, "workspace/models/server.npy"), "x");
      const c = await collectModelResultArtifacts({ ...ident, resultPath: root });
      expect(c.artifacts.some((a) => a.kind === "ROUND_METRICS")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
