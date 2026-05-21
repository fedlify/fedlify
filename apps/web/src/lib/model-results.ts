import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelArtifactKind } from "@prisma/client";
import { sha256 } from "@/lib/crypto";
import { objectKey } from "@/lib/storage";

export type CollectedModelArtifact = {
  kind: ModelArtifactKind;
  relativePath: string;
  filename: string;
  contentType: string;
  body: Buffer;
  checksum: string;
  sizeBytes: bigint;
};

export type CollectedModelResult = {
  resultPath: string;
  modelPath: string;
  modelShape: number[] | null;
  modelDtype: string | null;
  modelSizeBytes: bigint;
  checksum: string;
  manifest: Record<string, unknown>;
  artifacts: CollectedModelArtifact[];
};

const resultArtifactDefinitions: Array<{
  kind: ModelArtifactKind;
  relativePath: string;
  filename: string;
  contentType: string;
  required?: boolean;
}> = [
  {
    kind: "AGGREGATED_MODEL",
    relativePath: "workspace/models/server.npy",
    filename: "server.npy",
    contentType: "application/octet-stream",
    required: true
  },
  {
    kind: "METRICS",
    relativePath: "workspace/stats_pool_summary.json",
    filename: "stats_pool_summary.json",
    contentType: "application/json"
  },
  {
    kind: "LOG",
    relativePath: "workspace/log.txt",
    filename: "log.txt",
    contentType: "text/plain"
  },
  {
    kind: "META",
    relativePath: "workspace/meta.json",
    filename: "meta.json",
    contentType: "application/json"
  }
];

export function nextModelReleaseVersion(existingVersions: string[]) {
  const next = existingVersions.reduce((max, version) => {
    const match = /^model-v(\d+)\.0\.0$/.exec(version);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `model-v${next + 1}.0.0`;
}

export function modelReleaseChecksum(input: unknown) {
  return sha256(JSON.stringify(input));
}

export function parseNpyMetadata(buffer: Buffer): { shape: number[]; dtype: string } | null {
  if (buffer.length < 12 || buffer.toString("latin1", 0, 6) !== "\x93NUMPY") return null;
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.toString("latin1", headerStart, headerStart + headerLength);
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? null;
  const shapeBody = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "";
  const shape = shapeBody
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (!dtype || shape.length === 0) return null;
  return { shape, dtype };
}

export function resultStoragePrefix(studyId: string, jobId: string) {
  return objectKey(["studies", studyId, "nvflare-jobs", jobId, "results"]);
}

export function modelReleaseStoragePrefix(studyId: string, version: string) {
  return objectKey(["studies", studyId, "model-releases", version]);
}

export async function collectModelResultArtifacts(input: {
  resultPath: string;
  studyId: string;
  jobId: string;
  nvflareJobId: string | null;
  pipelineVersionId: string;
  storagePrefix: string;
}): Promise<CollectedModelResult> {
  const artifacts: CollectedModelArtifact[] = [];
  for (const definition of resultArtifactDefinitions) {
    const absolutePath = path.join(input.resultPath, definition.relativePath);
    const exists = await stat(absolutePath).then(
      (info) => info.isFile(),
      () => false
    );
    if (!exists) {
      if (definition.required) throw new Error(`Completed NVFLARE result is missing required artifact: ${definition.relativePath}`);
      continue;
    }
    const body = await readFile(absolutePath);
    artifacts.push({
      kind: definition.kind,
      relativePath: definition.relativePath,
      filename: definition.filename,
      contentType: definition.contentType,
      body,
      checksum: sha256(body),
      sizeBytes: BigInt(body.byteLength)
    });
  }

  const model = artifacts.find((artifact) => artifact.kind === "AGGREGATED_MODEL");
  if (!model) throw new Error("Completed NVFLARE result does not contain an aggregated model.");
  const npyMetadata = parseNpyMetadata(model.body);
  const manifest = {
    packageType: "fedlify-nvflare-model-result",
    version: "1.0.0",
    studyId: input.studyId,
    fedlifyJobId: input.jobId,
    nvflareJobId: input.nvflareJobId,
    pipelineVersionId: input.pipelineVersionId,
    resultPath: input.resultPath,
    model: {
      path: model.relativePath,
      filename: model.filename,
      checksum: model.checksum,
      sizeBytes: Number(model.sizeBytes),
      shape: npyMetadata?.shape ?? null,
      dtype: npyMetadata?.dtype ?? null
    },
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.relativePath,
      filename: artifact.filename,
      checksum: artifact.checksum,
      sizeBytes: Number(artifact.sizeBytes)
    }))
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
  artifacts.push({
    kind: "MANIFEST",
    relativePath: "model-result-manifest.json",
    filename: "model-result-manifest.json",
    contentType: "application/json",
    body: manifestBody,
    checksum: sha256(manifestBody),
    sizeBytes: BigInt(manifestBody.byteLength)
  });

  return {
    resultPath: input.resultPath,
    modelPath: model.relativePath,
    modelShape: npyMetadata?.shape ?? null,
    modelDtype: npyMetadata?.dtype ?? null,
    modelSizeBytes: model.sizeBytes,
    checksum: modelReleaseChecksum(manifest),
    manifest,
    artifacts
  };
}

