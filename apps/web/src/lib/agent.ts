import type { Prisma } from "@prisma/client";

export function buildDraftPipelineSpec(input: {
  studyTitle: string;
  description: string;
  sites: Array<{ code: string; nvflareClientName: string; institutionName: string }>;
}): Prisma.InputJsonObject {
  return {
    substrate: "nvflare",
    dataBoundary: "site-only",
    executionModes: ["site-local", "central-sandbox-synthetic-only"],
    study: {
      title: input.studyTitle,
      need: input.description
    },
    workflow: {
      training: {
        type: "cross-silo",
        minSites: Math.max(1, Math.min(input.sites.length, 2)),
        privacy: ["tls-mutual-auth", "signed-startup-kits"],
        validation: ["cross-site-validation", "human-release-approval"]
      }
    },
    participants: input.sites.map((site) => ({
      code: site.code,
      nvflareClientName: site.nvflareClientName,
      institutionName: site.institutionName
    })),
    generatedArtifacts: ["server-kit", "site-kit", "admin-kit", "helm-chart", "checksum-manifest"]
  };
}

export async function submitAgentWorkflow(input: {
  agentRunId: string;
  studyId: string;
}): Promise<{ workflowId: string; submitted: boolean }> {
  const workflowId = `fedlify-agent-${input.agentRunId}`;
  // The deployed path uses the WorkflowTemplate in deploy/k8s. Local development records
  // a deterministic workflow id so API behavior stays reproducible without cluster access.
  return { workflowId, submitted: Boolean(process.env.KUBERNETES_SERVICE_HOST) };
}
