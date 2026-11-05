import type { Prisma } from "@prisma/client";
import { buildModelCard, type DescriptorStatus, MODEL_CARD_FILENAME, type ModelCard, type PipelineDescriptor, readPipelineDescriptor } from "@/lib/model-card";
import { readGiteaFileAtRef } from "@/lib/gitea";
import { isCommitSha } from "@/lib/repo-path";
import { parseRoundMetricsJsonl } from "@/lib/round-metrics";
import { canAccessStudy } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

/** Evidence snapshotted on the job at submit, so the run detail does not depend on what the pipeline version looks like later. */
export function buildRunSnapshot(input: {
  pipelineVersion: { gitCommit: string | null; imageDigest: string | null };
  deployment: { imageDigest: string | null; runtimeMode: string | null };
  sites: Array<{ code: string; nvflareClientName: string; heartbeatMetadata: unknown; heartbeatAt: Date | null }>;
  runtimeParameters: { minClients: number; numRounds: number };
}) {
  // On a published study the aggregator's own digest is what ran; otherwise fall back to what publish recorded.
  const imageDigest = (input.deployment.runtimeMode === "k8s" ? input.deployment.imageDigest : null) ?? input.pipelineVersion.imageDigest ?? input.deployment.imageDigest ?? null;
  const siteDigests = input.sites.map((site) => {
    const meta = site.heartbeatMetadata && typeof site.heartbeatMetadata === "object" ? (site.heartbeatMetadata as Record<string, unknown>) : {};
    const digest = typeof meta.imageDigest === "string" && meta.imageDigest ? meta.imageDigest : null;
    // null = the site's runner had not reported a digest when the run was submitted. It is shown as "not reported".
    return { site: site.code, clientName: site.nvflareClientName, imageDigest: digest, reportedAt: digest && site.heartbeatAt ? site.heartbeatAt.toISOString() : null };
  });
  return {
    gitCommit: input.pipelineVersion.gitCommit ?? null,
    imageDigest,
    siteDigests: siteDigests as Prisma.InputJsonArray,
    runParameters: { minClients: input.runtimeParameters.minClients, numRounds: input.runtimeParameters.numRounds } as Prisma.InputJsonObject
  };
}

export type RunViewer = {
  scope: "full" | "site";
  /** Docker/aggregator logs: study managers only. */
  canViewLogs: boolean;
  canAudit: boolean;
  canSaveModel: boolean;
  canRelease: boolean;
  /** Site codes this user operates (used to restrict a site-scope viewer to their own rows). */
  ownSiteCodes: string[];
};

/**
 * Who may see a run, and how much. Returns null without study read access.
 * A site operator (study read access but none of the research or governance capabilities) gets the "site" scope:
 * their own sites' rows only, no logs, no audit, no model card.
 */
export async function resolveRunViewer(userId: string, studyId: string): Promise<RunViewer | null> {
  if (!(await canAccessStudy(userId, studyId, "read"))) return null;
  const [manage, audit, runAgent, approve] = await Promise.all([
    canAccessStudy(userId, studyId, "manage"),
    canAccessStudy(userId, studyId, "audit"),
    canAccessStudy(userId, studyId, "runAgent"),
    canAccessStudy(userId, studyId, "approveRelease")
  ]);
  const full = manage || audit || runAgent || approve;
  const ownSites = full
    ? []
    : await prisma.studySite.findMany({ where: { studyId, members: { some: { userId } } }, select: { code: true } });
  return {
    scope: full ? "full" : "site",
    canViewLogs: manage,
    canAudit: audit,
    canSaveModel: manage || approve,
    canRelease: approve,
    ownSiteCodes: ownSites.map((site) => site.code)
  };
}

/** Metric `site` values are NVFLARE client names; map a viewer's site codes to them via the job's selected sites. */
export function ownClientNames(selectedSites: unknown, ownSiteCodes: string[]): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(selectedSites)) return names;
  for (const entry of selectedSites) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { code?: unknown; nvflareClientName?: unknown };
    if (typeof e.code === "string" && ownSiteCodes.includes(e.code)) names.add(typeof e.nvflareClientName === "string" ? e.nvflareClientName : `site-${e.code}`);
  }
  return names;
}

/**
 * Artifact kinds a viewer may fetch from a release. The raw LOG is for study managers only; the all-site round metrics
 * and the model card are for the full scope only. Site operators may still fetch the model itself.
 */
export function artifactVisibleToViewer(kind: string, viewer: Pick<RunViewer, "scope" | "canViewLogs">): boolean {
  if (kind === "LOG") return viewer.canViewLogs;
  if (kind === "ROUND_METRICS" || kind === "MODEL_CARD") return viewer.scope === "full";
  return true;
}

/**
 * Best effort: the pipeline descriptor at the run's commit. The status says why the descriptor may be empty, so a
 * failed read is never confused with a pipeline that simply declares nothing.
 */
export async function loadPipelineDescriptor(project: { giteaOwner: string | null; giteaRepo: string | null }, commit: string | null): Promise<{ descriptor: PipelineDescriptor; status: DescriptorStatus }> {
  if (!project.giteaOwner || !project.giteaRepo || !isCommitSha(commit)) return { descriptor: readPipelineDescriptor(null), status: "no_commit" };
  try {
    const text = await readGiteaFileAtRef({ owner: project.giteaOwner, repo: project.giteaRepo, ref: commit, path: "fedlify-pipeline.json" });
    return { descriptor: readPipelineDescriptor(text), status: text === null ? "absent" : "read" };
  } catch {
    return { descriptor: readPipelineDescriptor(null), status: "unavailable" };
  }
}

export async function buildCardForJob(jobId: string, input: { modelVersion: string | null; releaseStatus: string | null; metricsBody: Buffer | null; metricsChecksum: string | null; modelChecksum: string | null; approvers: Array<{ userId: string; name: string | null; role: string; at: string | null }> }): Promise<ModelCard | null> {
  const job = await prisma.nvflareJob.findUnique({
    where: { id: jobId },
    include: { pipelineVersion: { include: { project: true } } }
  });
  if (!job) return null;
  // The commit the card states is the one recorded on the run. A run without one is "not recorded"; the pipeline
  // version's commit is only used to look up the descriptor, and the card says so.
  const descriptorCommit = job.gitCommit ?? job.pipelineVersion.gitCommit;
  const { descriptor, status: descriptorStatus } = await loadPipelineDescriptor(job.pipelineVersion.project, descriptorCommit);
  const sites = Array.isArray(job.selectedSites) ? (job.selectedSites as Array<{ code?: string }>).map((s) => s.code).filter((c): c is string => typeof c === "string") : [];
  return buildModelCard({
    studyId: job.studyId,
    jobId: job.id,
    nvflareJobId: job.nvflareJobId,
    modelVersion: input.modelVersion,
    releaseStatus: input.releaseStatus,
    generatedAt: new Date(),
    pipelineVersion: job.pipelineVersion.version,
    gitCommit: job.gitCommit ?? null,
    descriptorCommitRecordedOnRun: Boolean(job.gitCommit),
    descriptorStatus,
    imageDigest: job.imageDigest ?? null,
    siteDigests: job.siteDigests ?? null,
    selectedSiteCodes: sites,
    runParameters: job.runParameters ?? null,
    descriptor,
    metrics: input.metricsBody ? parseRoundMetricsJsonl(input.metricsBody.toString("utf8")) : null,
    metricsChecksum: input.metricsChecksum,
    modelChecksum: input.modelChecksum,
    approvers: input.approvers
  });
}

export { MODEL_CARD_FILENAME };

const LOG_SECRET = /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|X-Amz-(?:Signature|Credential)=[^&\s]+|:\/\/[^/\s:@]+:[^/\s@]+@|(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+)/gi;
export const LOG_MAX_BYTES = 200_000;

/** Masks secret-looking text, then caps the size in bytes. Redaction runs first so a secret cut by the cap is still matched. */
export function redactLogText(text: string): { text: string; truncated: boolean } {
  const redacted = text.replace(LOG_SECRET, "[redacted]");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= LOG_MAX_BYTES) return { text: redacted, truncated: false };
  return { text: bytes.subarray(bytes.byteLength - LOG_MAX_BYTES).toString("utf8").replace(/^\uFFFD+/, ""), truncated: true };
}
