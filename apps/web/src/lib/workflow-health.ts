// Pure helpers for judging Argo workflow pod health. Argo never fails a workflow on ImagePullBackOff (the pod
// just retries forever), so the web app inspects pods itself. No I/O here; see workflow-watchdog.ts.

export const STUCK_POD_REASONS = ["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError"] as const;
export const DEFAULT_STUCK_AFTER_MS = 8 * 60 * 1000;
// ErrImagePull is the transient first failure of a pull that may still succeed; only the backoff states are fatal.
export const FATAL_POD_REASONS = ["ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError"] as const;

export type PodLike = {
  metadata?: { name?: string; creationTimestamp?: string; annotations?: Record<string, string> };
  status?: {
    phase?: string;
    startTime?: string;
    containerStatuses?: PodContainerStatus[];
    initContainerStatuses?: PodContainerStatus[];
  };
};
type PodContainerStatus = { name?: string; image?: string; state?: { waiting?: { reason?: string; message?: string } } };

export type StuckPod = { podName: string; step: string; reason: string; image: string | null; waitedMs: number; message: string };

/** Step name from the pod's Argo node name ("<workflow>.<step>" or "<workflow>[0].<step>"); falls back to the pod name. */
export function podStep(pod: PodLike, workflowName?: string): string {
  const node = pod.metadata?.annotations?.["workflows.argoproj.io/node-name"];
  if (node) {
    let step = node.includes(".") ? node.slice(node.lastIndexOf(".") + 1) : node;
    if (workflowName && step === workflowName) step = "workflow";
    return step;
  }
  return pod.metadata?.name ?? "unknown";
}

function waitingStatus(pod: PodLike) {
  const all = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  return all.find((status) => status.state?.waiting?.reason && (FATAL_POD_REASONS as readonly string[]).includes(status.state.waiting.reason));
}

function podAgeMs(pod: PodLike, now: number): number {
  const started = Date.parse(pod.status?.startTime ?? pod.metadata?.creationTimestamp ?? "");
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** Pods that are still waiting on an image/config error after `stuckAfterMs`. Shorter waits are normal retries. */
export function detectStuckPods(pods: PodLike[], now: number, stuckAfterMs = DEFAULT_STUCK_AFTER_MS, workflowName?: string): StuckPod[] {
  const stuck: StuckPod[] = [];
  for (const pod of pods) {
    if (pod.status?.phase && pod.status.phase !== "Pending") continue;
    const status = waitingStatus(pod);
    if (!status) continue;
    const waitedMs = podAgeMs(pod, now);
    if (waitedMs < stuckAfterMs) continue;
    stuck.push({
      podName: pod.metadata?.name ?? "unknown",
      step: podStep(pod, workflowName),
      reason: status.state!.waiting!.reason!,
      image: status.image ?? null,
      waitedMs,
      message: status.state!.waiting!.message ?? ""
    });
  }
  return stuck;
}

/** Human-readable failure reason for the UI. */
export function describeStuckPod(stuck: StuckPod): string {
  const minutes = Math.max(1, Math.round(stuck.waitedMs / 60000));
  const what =
    stuck.reason === "CreateContainerConfigError" || stuck.reason === "CreateContainerError"
      ? `could not start (${stuck.reason})`
      : `could not pull its image (${stuck.reason})`;
  // Registry host/path and the kubelet message stay in server logs only; this text is shown to study readers.
  return `Publish stopped: step "${stuck.step}" ${what} after ${minutes} min. Ask a platform admin to check the image registry.`;
}

/** Step currently executing: the newest Running pod, else the newest Pending one. Null if none. */
export function currentStep(pods: PodLike[], workflowName?: string): { step: string; state: "running" | "pending" } | null {
  const byNewest = [...pods].sort((a, b) => Date.parse(b.metadata?.creationTimestamp ?? "") - Date.parse(a.metadata?.creationTimestamp ?? ""));
  const running = byNewest.find((pod) => pod.status?.phase === "Running");
  if (running) return { step: podStep(running, workflowName), state: "running" };
  const pending = byNewest.find((pod) => pod.status?.phase === "Pending");
  return pending ? { step: podStep(pending, workflowName), state: "pending" } : null;
}

// Argo's {{workflow.failures}} is a JSON list (sometimes JSON-quoted). Turn it into a sentence people can read.
export function readablePublishSummary(summary: string | undefined): string | undefined {
  if (!summary) return summary;
  const quoted = summary.indexOf('"[');
  const start = quoted >= 0 ? quoted : summary.indexOf("[{");
  if (start < 0) return summary;
  try {
    let raw: unknown = JSON.parse(summary.slice(start));
    if (typeof raw === "string") raw = JSON.parse(raw);
    if (!Array.isArray(raw)) return summary;
    const pods = raw.filter((item) => item?.templateName && item.templateName !== "publish" && item?.podName);
    const steps = pods.length > 0 ? pods : raw;
    const parts = steps.slice(0, 3).map((item) => `step "${item?.displayName ?? item?.templateName ?? "unknown"}": ${item?.message ?? "failed"}`);
    return parts.length > 0 ? `Publish failed in ${parts.join("; ")}` : summary;
  } catch {
    // Truncated or unexpected text: keep what we were given.
    return summary;
  }
}

