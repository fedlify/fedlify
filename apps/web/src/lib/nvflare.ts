import type { NvflareDeployment, NvflareJobStatus } from "@prisma/client";
import { flareApiBaseUrl } from "@/lib/runtime-config";

type SubmitJobInput = {
  fedlifyJobId: string;
  pipelineVersionId: string;
  selectedSiteCodes: string[];
  deployment?: (Pick<NvflareDeployment, "id" | "serverAddress" | "adminStartupKitStorageKey"> &
    Partial<Pick<NvflareDeployment, "adminStartupPath">>) | null;
  gitCommit?: string | null;
  jobWorkspacePath?: string | null;
  runtimeParameters?: {
    numClients: number;
    minClients: number;
    numRounds: number;
  };
};

type SystemInfoInput = {
  studyId: string;
  connectedSiteCount: number;
  runningJobCount: number;
  deployment?: (Pick<NvflareDeployment, "id" | "status" | "serverAddress" | "adminStartupKitStorageKey"> &
    Partial<Pick<NvflareDeployment, "adminStartupPath">>) | null;
};

export function buildNvflareJobId(fedlifyJobId: string): string {
  return `fedlify-${fedlifyJobId.slice(0, 12)}`;
}

export async function submitNvflareJob(input: SubmitJobInput): Promise<{ nvflareJobId: string; status: NvflareJobStatus; summary: string }> {
  if (!input.deployment?.serverAddress) {
    throw new Error("No active NVFLARE deployment address is available for job submission.");
  }

  const nvflareJobId = buildNvflareJobId(input.fedlifyJobId);
  const apiBaseUrl = flareApiBaseUrl();
  if (apiBaseUrl) {
    if (!input.deployment.adminStartupPath) {
      throw new Error("The active NVFLARE deployment does not have an admin startup kit path.");
    }
    if (!input.jobWorkspacePath) {
      throw new Error("The approved pipeline version does not have a local NVFLARE job workspace path.");
    }
    const response = await fetch(`${apiBaseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: nvflareJobId,
        deploymentId: input.deployment.id,
        adminStartupPath: input.deployment.adminStartupPath,
        jobWorkspacePath: input.jobWorkspacePath,
        pipelineVersionId: input.pipelineVersionId,
        gitCommit: input.gitCommit,
        selectedSites: input.selectedSiteCodes,
        runtimeParameters: input.runtimeParameters
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FLARE API submit_job failed with status ${response.status}: ${body}`);
    }
    const body = (await response.json().catch(() => null)) as { nvflareJobId?: string; status?: NvflareJobStatus } | null;
    return {
      nvflareJobId: body?.nvflareJobId ?? nvflareJobId,
      status: body?.status ?? "SUBMITTED",
      summary: `FLARE API submit_job queued ${input.pipelineVersionId} at ${input.deployment.serverAddress} for ${input.selectedSiteCodes.length} site(s); min_clients=${input.runtimeParameters?.minClients ?? input.selectedSiteCodes.length}, num_rounds=${input.runtimeParameters?.numRounds ?? "template"}.`
    };
  }

  return {
    nvflareJobId,
    status: "SUBMITTED",
    summary: `FLARE API submit_job queued ${input.pipelineVersionId} at ${input.deployment.serverAddress} for ${input.selectedSiteCodes.length} site(s); min_clients=${input.runtimeParameters?.minClients ?? input.selectedSiteCodes.length}, num_rounds=${input.runtimeParameters?.numRounds ?? "template"}.`
  };
}

export async function abortNvflareJob(input: { nvflareJobId: string | null; reason?: string }): Promise<{ status: NvflareJobStatus; summary: string }> {
  const apiBaseUrl = flareApiBaseUrl();
  if (apiBaseUrl && input.nvflareJobId) {
    const response = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(input.nvflareJobId)}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: input.reason })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FLARE API abort_job failed with status ${response.status}: ${body}`);
    }
  }

  return {
    status: "ABORTED",
    summary: `FLARE API abort_job requested for ${input.nvflareJobId ?? "unsubmitted job"}${input.reason ? `: ${input.reason}` : "."}`
  };
}

export async function downloadNvflareJobResult(input: {
  nvflareJobId: string | null;
  adminStartupPath?: string | null;
}): Promise<{ jobId: string; resultPath: string; files?: Array<{ path: string; kind: string; sizeBytes?: number | null }> }> {
  const apiBaseUrl = flareApiBaseUrl();
  if (!apiBaseUrl) throw new Error("NVFLARE_FLARE_API_BASE_URL is not configured.");
  if (!input.nvflareJobId) throw new Error("The Fedlify job does not have an NVFLARE job id.");
  if (!input.adminStartupPath) throw new Error("The active NVFLARE deployment does not have an admin startup kit path.");

  const query = new URLSearchParams({ adminStartupPath: input.adminStartupPath });
  const response = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(input.nvflareJobId)}/result?${query.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`FLARE API download_job_result failed with status ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json().catch(() => null)) as { jobId?: string; resultPath?: string; files?: Array<{ path: string; kind: string; sizeBytes?: number | null }> } | null;
  if (!body?.resultPath) throw new Error("FLARE API did not return a result path.");
  return {
    jobId: body.jobId ?? input.nvflareJobId,
    resultPath: body.resultPath,
    files: body.files
  };
}

export async function getNvflareSystemInfo(input: SystemInfoInput) {
  const apiBaseUrl = flareApiBaseUrl();
  if (apiBaseUrl && input.deployment) {
    const query = new URLSearchParams({
      deploymentId: input.deployment.id,
      ...(input.deployment.adminStartupPath ? { adminStartupPath: input.deployment.adminStartupPath } : {})
    });
    const response = await fetch(`${apiBaseUrl}/system-info?${query.toString()}`);
    if (response.ok) {
      return response.json();
    }
  }

  return {
    studyId: input.studyId,
    deploymentId: input.deployment?.id ?? null,
    mode: apiBaseUrl ? "flare-api-http" : "local-wrapper",
    serverAddress: input.deployment?.serverAddress ?? null,
    deploymentStatus: input.deployment?.status ?? null,
    connectedSiteCount: input.connectedSiteCount,
    runningJobCount: input.runningJobCount,
    message:
      "Fedlify records the FLARE API command surface. Configure NVFLARE_FLARE_API_BASE_URL to connect a live FLARE API adapter."
  };
}
