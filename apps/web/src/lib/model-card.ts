import { sha256 } from "@/lib/crypto";
import { METRICS_DISCLAIMER, type ParsedRoundMetrics, summarizeMetrics } from "@/lib/round-metrics";

/**
 * The model card is built only from values stored by Fedlify (job snapshot, stored round metrics, the pipeline
 * descriptor at the run's commit). Anything that is not stored is written as { recorded: false }, never guessed.
 */

export const MODEL_CARD_FILENAME = "model-card.json";
const NOT_RECORDED = { recorded: false } as const;

export type PipelineDescriptor = {
  features: string[] | null;
  hyperparameters: Record<string, unknown> | null;
  preprocessing: unknown;
  threshold: number | null;
  windowStatement: string | null;
  dataKind: string | null;
  dataContractHash: string | null;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reads fedlify-pipeline.json text. Unknown or malformed content yields all-null fields. */
export function readPipelineDescriptor(text: string | null): PipelineDescriptor {
  const empty: PipelineDescriptor = { features: null, hyperparameters: null, preprocessing: null, threshold: null, windowStatement: null, dataKind: null, dataContractHash: null };
  if (!text) return empty;
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    doc = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }
  const contract = doc.dataContract && typeof doc.dataContract === "object" && !Array.isArray(doc.dataContract) ? (doc.dataContract as Record<string, unknown>) : null;
  const features = contract && Array.isArray(contract.features) && contract.features.every((f) => typeof f === "string") ? (contract.features as string[]) : null;
  const hyper = doc.hyperparameters && typeof doc.hyperparameters === "object" && !Array.isArray(doc.hyperparameters) ? (doc.hyperparameters as Record<string, unknown>) : null;
  const threshold = typeof doc.threshold === "number" && Number.isFinite(doc.threshold) ? doc.threshold : contract && typeof contract.threshold === "number" ? (contract.threshold as number) : null;
  const windowStatement = contract && typeof contract.window === "string" ? contract.window : typeof doc.window === "string" ? (doc.window as string) : null;
  const dataKind = contract && typeof contract.dataKind === "string" ? contract.dataKind : typeof doc.dataKind === "string" ? (doc.dataKind as string) : null;
  return {
    features,
    hyperparameters: hyper,
    preprocessing: doc.preprocessing ?? (contract ? (contract.preprocessing ?? null) : null),
    threshold,
    windowStatement,
    dataKind,
    dataContractHash: contract ? sha256(stableStringify(contract)) : null
  };
}

/** Why the descriptor may be empty: read = fedlify-pipeline.json was read; absent = the commit has none; unavailable = the read failed; no_commit = no commit to read at. */
export type DescriptorStatus = "read" | "absent" | "unavailable" | "no_commit";

export type ModelCardInput = {
  studyId: string;
  jobId: string;
  nvflareJobId: string | null;
  modelVersion: string | null;
  releaseStatus: string | null;
  generatedAt: Date;
  pipelineVersion: string | null;
  gitCommit: string | null;
  imageDigest: string | null;
  siteDigests: unknown;
  selectedSiteCodes: string[];
  runParameters: unknown;
  descriptor: PipelineDescriptor;
  descriptorStatus: DescriptorStatus;
  /** False when the card has no commit of its own for the run (the descriptor was looked up at the pipeline version commit). */
  descriptorCommitRecordedOnRun: boolean;
  metrics: ParsedRoundMetrics | null;
  metricsChecksum: string | null;
  modelChecksum: string | null;
  approvers: Array<{ userId: string; name: string | null; role: string; at: string | null }>;
};

function rec<T>(value: T | null | undefined) {
  return value === null || value === undefined ? NOT_RECORDED : { recorded: true as const, value };
}

export function buildModelCard(input: ModelCardInput) {
  const d = input.descriptor;
  const summary = input.metrics ? summarizeMetrics(input.metrics) : null;
  const synthetic = d.dataKind ? /synthetic|simulat|test/i.test(d.dataKind) : false;
  return {
    schema: "fedlify-model-card/1",
    generatedAt: input.generatedAt.toISOString(),
    notices: [
      "Generated from values stored by Fedlify. A field marked recorded:false was not stored for this run and is not guessed.",
      METRICS_DISCLAIMER,
      "Nothing in this card states or implies that the model is clinically valid or fit for clinical use.",
      ...(d.dataKind === null
        ? [
            input.descriptorStatus === "unavailable"
              ? "The pipeline descriptor could not be read when this card was generated (code host unavailable), so the kind of data is unknown. Do not assume the data is real; it may be synthetic, test or simulated."
              : input.descriptorStatus === "read"
                ? "The pipeline descriptor does not declare what kind of data was used. Fedlify does not know whether it is real, synthetic, test or simulated; treat it as unverified."
                : "The kind of data used is not recorded for this run. Fedlify does not know whether it is real, synthetic, test or simulated; treat it as unverified."
          ]
        : []),
      ...(input.descriptorStatus !== "no_commit" && !input.descriptorCommitRecordedOnRun ? ["This run has no commit recorded on it; the pipeline descriptor was read at the commit of the pipeline version, which may differ from what ran."] : []),
      ...(synthetic ? [`The pipeline descriptor labels its data as "${d.dataKind}". Treat every number here as coming from synthetic, test or simulated data.`] : [])
    ],
    model: { studyId: input.studyId, version: rec(input.modelVersion), releaseStatus: rec(input.releaseStatus), checksum: rec(input.modelChecksum) },
    run: { fedlifyJobId: input.jobId, nvflareJobId: rec(input.nvflareJobId), sites: input.selectedSiteCodes, parameters: rec(input.runParameters) },
    code: {
      pipelineVersion: rec(input.pipelineVersion),
      gitCommit: rec(input.gitCommit),
      imageDigest: rec(input.imageDigest),
      siteReportedDigests: rec(input.siteDigests),
      imageSignature: { verified: false, note: "No image signature or attestation check is implemented. A digest identifies the image; it does not vouch for it." }
    },
    data: {
      descriptorStatus: input.descriptorStatus,
      kind: rec(d.dataKind),
      featureList: rec(d.features),
      featureCount: rec(d.features ? d.features.length : null),
      preprocessing: rec(d.preprocessing),
      hyperparameters: rec(d.hyperparameters),
      decisionThreshold: rec(d.threshold),
      dataContractHash: rec(d.dataContractHash),
      windowStatement: rec(d.windowStatement)
    },
    performance: input.metrics
      ? {
          status: input.metrics.rounds.length ? "stored" : "stored-but-empty",
          source: { artifact: "fedlify_metrics.jsonl", checksum: rec(input.metricsChecksum) },
          scoredOn: "global model on each site's local validation split (not a held-out test)",
          rounds: input.metrics.rounds.map((r) => ({ round: r.round, average: r.average, weighting: r.weighting, sites: r.sites, missing: r.missing })),
          best: summary?.best ?? NOT_RECORDED,
          last: summary?.last ?? NOT_RECORDED
        }
      : { status: "missing", note: "No round metrics were stored for this run. No performance figures are given." },
    approvers: input.approvers,
    limitations: [
      "Per-site metrics are on local validation splits; no external or held-out evaluation is recorded here.",
      "Calibration, subgroup performance and confidence intervals are not recorded.",
      "Not clinically validated."
    ]
  };
}

export type ModelCard = ReturnType<typeof buildModelCard>;
