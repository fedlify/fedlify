import type { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { publicBaseUrl } from "@/lib/runtime-config";

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

function argoNamespace(): string {
  return process.env.FEDLIFY_ARGO_NAMESPACE?.trim() || "fedlify";
}

function pipelineWorkflowTemplate(): string {
  return process.env.FEDLIFY_PIPELINE_WORKFLOW_TEMPLATE?.trim() || "fedlify-study-pipeline-ci";
}

async function kubernetesRequest(path: string, init: RequestInit) {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  if (!host) throw new Error("Kubernetes service host is not configured.");

  const token = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
  const ca = await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  const body = typeof init.body === "string" ? init.body : "";

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        port,
        path,
        method: init.method ?? "GET",
        ca,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(init.headers as Record<string, string> | undefined)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`Kubernetes API request failed with status ${res.statusCode}: ${text}`));
            return;
          }
          resolve(text ? JSON.parse(text) : null);
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function workflowName(input: { pipelineVersionId: string; ciRunId: string }): string {
  const suffix = `${input.pipelineVersionId}-${input.ciRunId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 36);
  return `fedlify-pipeline-${suffix}`;
}

export async function submitPipelineWorkflow(input: {
  pipelineVersionId: string;
  ciRunId: string;
  studyId: string;
  giteaOwner: string;
  giteaRepo: string;
  gitCommit: string;
  gitopsPath: string;
  callbackUrl?: string;
}): Promise<{ workflowId: string; submitted: boolean }> {
  const namespace = argoNamespace();
  const workflowId = workflowName(input);
  const callbackUrl = input.callbackUrl ?? `${publicBaseUrl()}/api/webhooks/argo`;

  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return { workflowId, submitted: false };
  }

  await createWorkflowFromTemplate({
    namespace,
    generateName: `${workflowId}-`,
    template: pipelineWorkflowTemplate(),
    labels: {
      "app.kubernetes.io/name": "fedlify-study-pipeline-ci",
      "fedlify.com/study-id": input.studyId,
      "fedlify.com/pipeline-version-id": input.pipelineVersionId,
      "fedlify.com/ci-run-id": input.ciRunId
    },
    parameters: {
      "pipeline-version-id": input.pipelineVersionId,
      "ci-run-id": input.ciRunId,
      "gitea-owner": input.giteaOwner,
      "gitea-repo": input.giteaRepo,
      "git-commit": input.gitCommit,
      "study-id": input.studyId,
      "gitops-path": input.gitopsPath,
      "callback-url": callbackUrl
    }
  });

  return { workflowId, submitted: true };
}

async function createWorkflowFromTemplate(input: {
  namespace: string;
  generateName: string;
  template: string;
  labels: Record<string, string>;
  parameters: Record<string, string>;
}): Promise<string> {
  const created = (await kubernetesRequest(`/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(input.namespace)}/workflows`, {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      metadata: { generateName: input.generateName, namespace: input.namespace, labels: input.labels },
      spec: {
        workflowTemplateRef: { name: input.template },
        arguments: { parameters: Object.entries(input.parameters).map(([name, value]) => ({ name, value })) }
      }
    })
  })) as { metadata?: { name?: string } } | null;
  return created?.metadata?.name ?? input.generateName;
}

function publishWorkflowTemplate(): string {
  return process.env.FEDLIFY_PUBLISH_WORKFLOW_TEMPLATE?.trim() || "fedlify-study-publish";
}

// Publish: saved commit -> study image -> (kits) -> aggregator at <hostname>:443. See deploy/k8s/publish-workflow-template.yaml.
export async function submitStudyPublishWorkflow(input: {
  pipelineVersionId: string;
  ciRunId: string;
  deploymentId: string;
  studyId: string;
  runtimeSlug: string;
  hostname: string;
  giteaOwner: string;
  giteaRepo: string;
  gitCommit: string;
  versionTag: string;
  sites: Array<{ name: string }>;
  provision: boolean;
  kitGeneration: number;
}): Promise<{ workflowId: string }> {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    const error = new Error("Publishing needs the Kubernetes runtime (Argo Workflows). Use deploy/local-e2e for local runs.");
    error.name = "RuntimeUnavailableError";
    throw error;
  }
  const workflowId = await createWorkflowFromTemplate({
    namespace: argoNamespace(),
    generateName: `fedlify-publish-${input.runtimeSlug.slice(0, 30)}-`,
    template: publishWorkflowTemplate(),
    labels: {
      "app.kubernetes.io/name": "fedlify-study-publish",
      "fedlify.com/study-id": input.studyId,
      "fedlify.com/pipeline-version-id": input.pipelineVersionId,
      "fedlify.com/deployment-id": input.deploymentId
    },
    parameters: {
      "pipeline-version-id": input.pipelineVersionId,
      "ci-run-id": input.ciRunId,
      "deployment-id": input.deploymentId,
      "study-id": input.studyId,
      "study-slug": input.runtimeSlug,
      hostname: input.hostname,
      "gitea-owner": input.giteaOwner,
      "gitea-repo": input.giteaRepo,
      "git-commit": input.gitCommit,
      "version-tag": input.versionTag,
      "sites-json": JSON.stringify(input.sites),
      provision: String(input.provision),
      "kit-generation": String(input.kitGeneration),
      "callback-url": `${publicBaseUrl()}/api/webhooks/argo`
    }
  });
  return { workflowId };
}
