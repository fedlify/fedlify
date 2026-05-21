import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NvflareJobEventType, NvflareJobStatus, Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { flareApiBaseUrl } from "@/lib/runtime-config";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

const execFileAsync = promisify(execFile);
const terminalStatuses = new Set<NvflareJobStatus>(["COMPLETED", "FAILED", "ABORTED", "REJECTED"]);

function normalizeNvflareJobStatus(value: unknown): NvflareJobStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replaceAll(" ", "_");
  if (normalized.includes("EXECUTION_EXCEPTION") || normalized.includes("EXCEPTION") || normalized.includes("FAILED")) return "FAILED";
  if (normalized.includes("ABORT") || normalized.includes("CANCEL")) return "ABORTED";
  if (normalized.startsWith("FINISHED")) return "COMPLETED";
  if (normalized.includes("RUNNING") || normalized.includes("EXECUTING")) return "RUNNING";
  if (normalized === "FINISHED" || normalized === "COMPLETE") return "COMPLETED";
  if (normalized === "CANCELED" || normalized === "CANCELLED") return "ABORTED";
  const allowed: NvflareJobStatus[] = ["DRAFT", "SUBMITTED", "SCHEDULED", "RUNNING", "COMPLETED", "FAILED", "ABORTED", "REJECTED"];
  return allowed.includes(normalized as NvflareJobStatus) ? (normalized as NvflareJobStatus) : null;
}

function eventTypeForStatus(status: NvflareJobStatus): NvflareJobEventType {
  if (status === "RUNNING") return "STARTED";
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  if (status === "ABORTED") return "ABORTED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "SCHEDULED") return "SCHEDULED";
  return "SITE_UPDATE";
}

async function fetchNvflareJobMeta(job: {
  nvflareJobId: string | null;
  deployment?: { adminStartupPath?: string | null } | null;
}) {
  const apiBaseUrl = flareApiBaseUrl();
  if (!apiBaseUrl || !job.nvflareJobId || !job.deployment?.adminStartupPath) return null;
  const query = new URLSearchParams({ adminStartupPath: job.deployment.adminStartupPath });
  const response = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(job.nvflareJobId)}/meta?${query.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    return { error: `FLARE API get_job_meta failed with status ${response.status}: ${await response.text()}` };
  }
  return response.json().catch(() => null);
}

async function fetchNvflareJobResult(job: {
  nvflareJobId: string | null;
  deployment?: { adminStartupPath?: string | null } | null;
}) {
  const apiBaseUrl = flareApiBaseUrl();
  if (!apiBaseUrl || !job.nvflareJobId || !job.deployment?.adminStartupPath) return null;
  const query = new URLSearchParams({ adminStartupPath: job.deployment.adminStartupPath });
  const response = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(job.nvflareJobId)}/result?${query.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    return { error: `FLARE API download_job_result failed with status ${response.status}: ${await response.text()}` };
  }
  return response.json().catch(() => null);
}

async function dockerContainerLogs(input: { composeProject?: string | null; selectedSites?: unknown }) {
  if (!input.composeProject && !input.selectedSites) return [];

  const selectedSites = Array.isArray(input.selectedSites)
    ? input.selectedSites
        .map((site) => (typeof site === "object" && site ? String((site as { code?: unknown }).code ?? "") : ""))
        .filter(Boolean)
    : [];
  const response = await execFileAsync("docker", ["ps", "--format", "{{json .}}"], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).catch(
    () => null
  );
  if (!response) return [];

  const containers = response.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { Names?: string; Image?: string; Status?: string };
      } catch {
        return null;
      }
    })
    .filter((container): container is { Names?: string; Image?: string; Status?: string } => Boolean(container?.Names))
    .filter((container) => {
      const name = container.Names ?? "";
      return Boolean(input.composeProject && name.includes(input.composeProject)) || selectedSites.some((siteCode) => name.includes(siteCode));
    });

  const logs = [];
  for (const container of containers) {
    const output = await execFileAsync("docker", ["logs", "--tail", "120", container.Names ?? ""], {
      timeout: 10_000,
      maxBuffer: 512 * 1024
    }).catch((error) => ({ stdout: "", stderr: error instanceof Error ? error.message : "Docker logs failed." }));
    logs.push({
      container: container.Names,
      image: container.Image,
      status: container.Status,
      output: [output.stdout, output.stderr].filter(Boolean).join("\n").trim()
    });
  }
  return logs;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { jobId } = await context.params;

  const job = await prisma.nvflareJob.findUnique({
    where: { id: jobId },
    include: {
      deployment: true,
      pipelineVersion: { include: { project: true } },
      logArtifacts: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" } },
      result: { include: { artifacts: true, modelRelease: { include: { artifacts: true } } } }
    }
  });
  if (!job) return problem(404, "NVFLARE job not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, job.studyId, "viewLogs");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const flareMeta = await fetchNvflareJobMeta(job);
  const flareStatus = normalizeNvflareJobStatus((flareMeta as { meta?: { status?: unknown } } | null)?.meta?.status);
  let refreshedJob = job;

  if (flareStatus && flareStatus !== job.status) {
    refreshedJob = await prisma.$transaction(async (tx) => {
      await tx.nvflareJobEvent.create({
        data: {
          jobId: job.id,
          studyId: job.studyId,
          eventType: eventTypeForStatus(flareStatus),
          message: `FLARE API reported job status ${flareStatus}.`,
          metadata: { flareMeta } as Prisma.InputJsonObject
        }
      });
      return tx.nvflareJob.update({
        where: { id: job.id },
        data: {
          status: flareStatus,
          completedAt: terminalStatuses.has(flareStatus) ? new Date() : job.completedAt
        },
        include: {
          deployment: true,
          pipelineVersion: { include: { project: true } },
          logArtifacts: { orderBy: { createdAt: "desc" } },
          events: { orderBy: { createdAt: "desc" } },
          result: { include: { artifacts: true, modelRelease: { include: { artifacts: true } } } }
        }
      });
    });
  }

  const runtimeLogs = await dockerContainerLogs({
    composeProject: refreshedJob.deployment?.composeProject,
    selectedSites: refreshedJob.selectedSites
  });
  const result =
    (flareStatus === "COMPLETED" || refreshedJob.status === "COMPLETED") && refreshedJob.nvflareJobId
      ? await fetchNvflareJobResult(refreshedJob)
      : null;

  return json({
    job: refreshedJob,
    state: {
      fedlifyStatus: refreshedJob.status,
      nvflareStatus: (flareMeta as { meta?: { status?: unknown } } | null)?.meta?.status ?? null,
      nvflareJobId: refreshedJob.nvflareJobId,
      submittedAt: refreshedJob.submittedAt,
      completedAt: refreshedJob.completedAt,
      commandSummary: refreshedJob.commandSummary
    },
    flareMeta,
    result,
    modelResult: refreshedJob.result,
    logs: refreshedJob.logArtifacts,
    runtimeLogs,
    events: refreshedJob.events,
    message:
      refreshedJob.logArtifacts.length === 0
        ? "No external log artifacts are linked yet. Runtime events and live local Docker logs are available."
        : undefined
  });
}
