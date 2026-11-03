import { hmacSha256 } from "@/lib/crypto";
import { slugify } from "@/lib/slug";

// Published studies run one NVFLARE aggregator each, at <slug>.<domain>:443, in namespace study-<slug>.
// The web app talks to it only through the FLARE API adapter sidecar (deploy/k8s/study-aggregator).

const DNS_LABEL_MAX = 40;

export class StudyRuntimeError extends Error {
  constructor(
    message: string,
    public readonly status = 502
  ) {
    super(message);
    this.name = "StudyRuntimeError";
  }
}

export function studyDomain(): string {
  return process.env.FEDLIFY_STUDY_DOMAIN?.trim() || "fedlify.com";
}

export function studyRuntimeSlug(studySlug: string, suffix?: string): string {
  const base = slugify(studySlug).slice(0, DNS_LABEL_MAX).replace(/-+$/g, "") || "study";
  return suffix ? `${base.slice(0, DNS_LABEL_MAX - suffix.length - 1)}-${suffix}` : base;
}

export function studyHostname(runtimeSlug: string): string {
  return `${runtimeSlug}.${studyDomain()}`;
}

export function studyNamespace(runtimeSlug: string): string {
  return `study-${runtimeSlug}`;
}

export function studyAdapterUrl(runtimeSlug: string): string {
  return process.env.FEDLIFY_ADAPTER_URL_TEMPLATE?.replace("{slug}", runtimeSlug) ?? `http://aggregator.${studyNamespace(runtimeSlug)}.svc.cluster.local:3010`;
}

export function runtimeSlugFromHostname(hostname: string): string {
  return hostname.split(".")[0];
}

// Must match the publish workflow: HMAC-SHA256(secret, "adapter:<studyId>") as hex.
export function studyAdapterToken(studyId: string): string {
  const secret = process.env.FEDLIFY_ADAPTER_SIGNING_SECRET?.trim();
  if (!secret) throw new StudyRuntimeError("FEDLIFY_ADAPTER_SIGNING_SECRET is not configured.", 503);
  return hmacSha256(secret, `adapter:${studyId}`);
}

// NVFLARE participant names: letters, digits, '-' and '_' only.
export function nvflareClientName(input: { code: string; nvflareClientName?: string | null }): string {
  const raw = input.nvflareClientName || `site_${input.code}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 63) || `site_${input.code}`;
}

export function clientKitStorageKey(prefix: string, clientName: string): string {
  return `${prefix.replace(/\/+$/, "")}/${clientName}.zip`;
}

export function clientKitPrefix(studyId: string, deploymentId: string): string {
  return `studies/${studyId}/deployments/${deploymentId}/clients`;
}

export type AdapterSystemInfo = {
  server: { status: string; startTime?: number | null };
  clients: Array<{ name: string; lastConnectTime?: number | null }>;
  runningJobs: Array<{ jobId: string | null; appName: string | null }>;
};

export type AdapterMetricRecord = {
  ts: number;
  event: "contribution" | "round_done";
  round: number | null;
  site?: string;
  numSamples?: number;
  metrics?: Record<string, number | string>;
};

type AdapterTarget = { adapterUrl: string | null; studyId: string };

async function adapterFetch(target: AdapterTarget, path: string, init?: RequestInit): Promise<Response> {
  if (!target.adapterUrl) throw new StudyRuntimeError("This study has no published aggregator yet.", 409);
  let response: Response;
  try {
    response = await fetch(`${target.adapterUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${studyAdapterToken(target.studyId)}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.FEDLIFY_ADAPTER_TIMEOUT_MS ?? 60_000))
    });
  } catch (error) {
    throw new StudyRuntimeError(`Aggregator adapter is unreachable: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new StudyRuntimeError(`Aggregator adapter returned ${response.status}: ${body?.error ?? response.statusText}`);
  }
  return response;
}

export async function adapterSystemInfo(target: AdapterTarget): Promise<AdapterSystemInfo> {
  return (await adapterFetch(target, "/system-info")).json();
}

export async function adapterSubmitJob(
  target: AdapterTarget,
  input: { jobName: string; numRounds: number; minClients: number }
): Promise<{ nvflareJobId: string }> {
  return (await adapterFetch(target, "/jobs", { method: "POST", body: JSON.stringify(input) })).json();
}

export async function adapterJobMeta(target: AdapterTarget, nvflareJobId: string): Promise<{ status: string; meta: Record<string, unknown> }> {
  const body = (await (await adapterFetch(target, `/jobs/${encodeURIComponent(nvflareJobId)}`)).json()) as { meta?: Record<string, unknown> };
  return { status: String(body.meta?.status ?? "UNKNOWN"), meta: body.meta ?? {} };
}

export async function adapterJobMetrics(target: AdapterTarget, nvflareJobId: string): Promise<{ source: string; records: AdapterMetricRecord[] }> {
  return (await adapterFetch(target, `/jobs/${encodeURIComponent(nvflareJobId)}/metrics`)).json();
}

export async function adapterJobResultZip(target: AdapterTarget, nvflareJobId: string): Promise<Buffer> {
  return Buffer.from(await (await adapterFetch(target, `/jobs/${encodeURIComponent(nvflareJobId)}/result.zip`)).arrayBuffer());
}

export async function adapterAbortJob(target: AdapterTarget, nvflareJobId: string): Promise<void> {
  await adapterFetch(target, `/jobs/${encodeURIComponent(nvflareJobId)}/abort`, { method: "POST", body: "{}" });
}

// NVFLARE job meta status ("RUNNING", "FINISHED:COMPLETED", "FINISHED:EXECUTION_EXCEPTION", ...) -> Fedlify status.
export function fedlifyJobStatus(nvflareStatus: string): "SUBMITTED" | "RUNNING" | "COMPLETED" | "FAILED" | "ABORTED" {
  const status = nvflareStatus.toUpperCase();
  if (status === "FINISHED:COMPLETED") return "COMPLETED";
  if (status.startsWith("FINISHED:ABORTED")) return "ABORTED";
  if (status.startsWith("FINISHED")) return "FAILED";
  if (status === "RUNNING") return "RUNNING";
  return "SUBMITTED";
}

// Per-round view for the dashboard: one row per (round, site) plus the sample-weighted round average.
export function summarizeRoundMetrics(records: AdapterMetricRecord[]) {
  const rounds = new Map<number, { round: number; sites: Array<{ site: string; numSamples: number; metrics: Record<string, number> }> }>();
  for (const record of records) {
    if (record.event !== "contribution" || record.round == null || !record.site) continue;
    const entry = rounds.get(record.round) ?? { round: record.round, sites: [] };
    const metrics = Object.fromEntries(
      Object.entries(record.metrics ?? {}).filter((pair): pair is [string, number] => typeof pair[1] === "number")
    );
    entry.sites.push({ site: record.site, numSamples: Number(record.numSamples ?? 0), metrics });
    rounds.set(record.round, entry);
  }
  return [...rounds.values()]
    .sort((a, b) => a.round - b.round)
    .map((entry) => {
      const total = entry.sites.reduce((sum, site) => sum + (site.numSamples || 1), 0);
      const keys = [...new Set(entry.sites.flatMap((site) => Object.keys(site.metrics)))];
      const weighted = Object.fromEntries(
        keys.map((key) => [
          key,
          entry.sites.reduce((sum, site) => sum + (site.metrics[key] ?? 0) * (site.numSamples || 1), 0) / total
        ])
      );
      return { ...entry, weighted };
    });
}
