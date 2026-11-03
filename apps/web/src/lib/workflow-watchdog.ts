import { Prisma } from "@prisma/client";
import { getWorkflowSnapshot, stopWorkflow } from "@/lib/agent";
import { prisma } from "@/lib/prisma";
import { currentStep, describeStuckPod, detectStuckPods, STUCK_POD_REASONS } from "@/lib/workflow-health";

export type PublishLiveStatus = { step: string | null; stepState: "running" | "pending" | null; waiting: string | null };

const TERMINAL_PHASES = ["Succeeded", "Failed", "Error"];

/**
 * Lazy watchdog, called from GET /aggregator while a publish is in flight. Reads the workflow's pods; if one has sat
 * on an image-pull/config error past the threshold it stops the workflow and fails the run with the reason.
 * Returns the live step (for the UI) or null when the cluster cannot be queried (local dev, RBAC, API error).
 * The failure bookkeeping mirrors webhooks/argo handleStudyPublish.
 */
export async function checkPublishRun(input: {
  ciRunId: string;
  pipelineVersionId: string;
  deploymentId: string;
  workflowId: string;
}): Promise<PublishLiveStatus | null> {
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  let snapshot;
  try {
    snapshot = await getWorkflowSnapshot(input.workflowId);
  } catch (error) {
    console.warn("publish watchdog: cannot read workflow", input.workflowId, error instanceof Error ? error.message : error);
    return null;
  }
  if (snapshot.phase && TERMINAL_PHASES.includes(snapshot.phase)) return null; // the exit-handler callback owns the outcome

  const step = currentStep(snapshot.pods, input.workflowId);
  const [stuck] = detectStuckPods(snapshot.pods, Date.now(), undefined, input.workflowId);
  if (!stuck) {
    const waiting = snapshot.pods.some((pod) =>
      [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])].some((s) =>
        (STUCK_POD_REASONS as readonly string[]).includes(s.state?.waiting?.reason ?? "")
      )
    );
    return { step: step?.step ?? null, stepState: step?.state ?? null, waiting: waiting ? "Image pull is failing; retrying." : null };
  }

  const reason = describeStuckPod(stuck);
  console.warn("publish watchdog: stopping workflow", input.workflowId, stuck.podName, stuck.reason, stuck.image, stuck.message.slice(0, 300));
  try {
    await stopWorkflow(input.workflowId);
  } catch (error) {
    // Do not fail the run while the workflow may still complete (the callback could later write PASSED over it); retry next poll.
    console.warn("publish watchdog: cannot stop workflow", input.workflowId, error instanceof Error ? error.message : error);
    return { step: stuck.step, stepState: "pending", waiting: "Image pull is failing; retrying." };
  }
  await prisma.$transaction(async (tx) => {
    // Only the first caller wins; a callback or a concurrent poll may already have finished this run.
    const claimed = await tx.cIValidationRun.updateMany({
      where: { id: input.ciRunId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", summary: reason, completedAt: new Date() }
    });
    if (claimed.count === 0) return;
    await tx.pipelineVersion.update({ where: { id: input.pipelineVersionId }, data: { validationStatus: "FAILED" } });
    const deployment = await tx.nvflareDeployment.findUnique({ where: { id: input.deploymentId } });
    if (!deployment) return;
    await tx.nvflareDeployment.update({
      where: { id: deployment.id },
      data: {
        lastError: reason,
        // Nothing was ever published: undo the provisioning bookkeeping the publish route wrote ahead of the workflow.
        ...(deployment.imageDigest ? {} : { kitGeneration: 0, provisionedSites: Prisma.JsonNull, clientKitPrefix: null })
      }
    });
  });
  return { step: stuck.step, stepState: "pending", waiting: reason };
}
