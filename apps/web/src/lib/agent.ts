import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { publicBaseUrl } from "@/lib/runtime-config";

function argoNamespace(): string {
  return process.env.FEDLIFY_ARGO_NAMESPACE?.trim() || "fedlify";
}

// Workflow callbacks should reach the web app inside the cluster (Service URL), not through the public
// edge: Cloudflare blocks the urllib user agent the callback step uses, and the hop is pointless anyway.
function callbackUrl(): string {
  const base = process.env.FEDLIFY_CALLBACK_BASE_URL?.trim() || publicBaseUrl();
  return `${base.replace(/\/$/, "")}/api/webhooks/argo`;
}

function pipelineWorkflowTemplate(): string {
  return process.env.FEDLIFY_PIPELINE_WORKFLOW_TEMPLATE?.trim() || "fedlify-study-pipeline-ci";
}

export async function kubernetesRequest(path: string, init: RequestInit, options: { asText?: boolean } = {}) {
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
          if (options.asText) resolve(text);
          else resolve(text ? JSON.parse(text) : null);
        });
      }
    );
    req.setTimeout(10_000, () => req.destroy(new Error("Kubernetes API request timed out.")));
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
  const resolvedCallbackUrl = input.callbackUrl ?? callbackUrl();

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
      "callback-url": resolvedCallbackUrl
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
  /** Per-study Harbor project (`fedlify-s-<slug>`) when the registry mode is per-study; null keeps the legacy shared project. */
  registryProject?: string | null;
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
      "callback-url": callbackUrl(),
      "registry-mode": input.registryProject ? "per-study" : "legacy",
      "registry-project": input.registryProject ?? "",
      // Only overridden for a per-study project; legacy publishes keep the template default (fedlify-studies).
      ...(input.registryProject ? { "study-image-repo": `${process.env.FEDLIFY_STUDY_REGISTRY?.trim() || "harbor.fedlify.com"}/${input.registryProject}` } : {})
    }
  });
  return { workflowId };
}

export type WorkflowSnapshot = { phase: string | null; pods: import("@/lib/workflow-health").PodLike[] };

/** Workflow phase plus its pods (read-only). Needs get on workflows and list on pods. */
export async function getWorkflowSnapshot(workflowName: string): Promise<WorkflowSnapshot> {
  const ns = encodeURIComponent(argoNamespace());
  const workflow = (await kubernetesRequest(`/apis/argoproj.io/v1alpha1/namespaces/${ns}/workflows/${encodeURIComponent(workflowName)}`, { method: "GET" })) as {
    status?: { phase?: string };
  } | null;
  const selector = encodeURIComponent(`workflows.argoproj.io/workflow=${workflowName}`);
  const pods = (await kubernetesRequest(`/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`, { method: "GET" })) as {
    items?: import("@/lib/workflow-health").PodLike[];
  } | null;
  return { phase: workflow?.status?.phase ?? null, pods: pods?.items ?? [] };
}

export type WorkflowNode = {
  id?: string;
  name?: string;
  displayName?: string;
  type?: string;
  phase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
};

/** Workflow phase, message and node states plus its pods (read-only). Needs get on workflows and list on pods. */
export async function getWorkflowDiagnostics(workflowName: string): Promise<{
  phase: string | null;
  message: string | null;
  nodes: WorkflowNode[];
  pods: import("@/lib/workflow-health").PodLike[];
}> {
  const ns = encodeURIComponent(argoNamespace());
  const workflow = (await kubernetesRequest(`/apis/argoproj.io/v1alpha1/namespaces/${ns}/workflows/${encodeURIComponent(workflowName)}`, { method: "GET" })) as {
    status?: { phase?: string; message?: string; nodes?: Record<string, WorkflowNode> };
  } | null;
  const selector = encodeURIComponent(`workflows.argoproj.io/workflow=${workflowName}`);
  const pods = (await kubernetesRequest(`/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`, { method: "GET" })) as {
    items?: import("@/lib/workflow-health").PodLike[];
  } | null;
  return {
    phase: workflow?.status?.phase ?? null,
    message: workflow?.status?.message ?? null,
    nodes: Object.values(workflow?.status?.nodes ?? {}),
    pods: pods?.items ?? []
  };
}

/** Raw tail of one pod container's log, capped by the API server (lines and bytes). Needs get on pods/log. */
export async function getPodLogTail(podName: string, options: { container?: string; tailLines: number; limitBytes: number }): Promise<string> {
  const ns = encodeURIComponent(argoNamespace());
  const query = `container=${encodeURIComponent(options.container ?? "main")}&tailLines=${options.tailLines}&limitBytes=${options.limitBytes}`;
  const text = await kubernetesRequest(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(podName)}/log?${query}`, { method: "GET", headers: { accept: "*/*" } }, { asText: true });
  return typeof text === "string" ? text : "";
}

/** spec.shutdown=Stop: running pods are stopped and the onExit handler still runs. Needs patch on workflows. */
export async function stopWorkflow(workflowName: string): Promise<void> {
  await kubernetesRequest(`/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(argoNamespace())}/workflows/${encodeURIComponent(workflowName)}`, {
    method: "PATCH",
    headers: { "content-type": "application/merge-patch+json" },
    body: JSON.stringify({ spec: { shutdown: "Stop" } })
  });
}
