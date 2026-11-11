import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { verifyHmacSignature } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { readablePublishSummary } from "@/lib/workflow-health";

const argoPayloadSchema = z.object({
  pipelineVersionId: z.string().optional(),
  ciRunId: z.string().optional(),
  workflowId: z.string(),
  phase: z.enum(["Pending", "Running", "Succeeded", "Failed", "Error"]),
  logsStorageKey: z.string().optional(),
  validationSummary: z.string().optional()
});

// Callbacks from deploy/k8s/publish-workflow-template.yaml.
const studyPublishSchema = z.object({
  kind: z.literal("study-publish"),
  pipelineVersionId: z.string().min(1),
  ciRunId: z.string().min(1),
  deploymentId: z.string().min(1),
  workflowId: z.string(),
  phase: z.enum(["Succeeded", "Failed", "Error"]),
  stage: z.enum(["published", "failed"]),
  imageDigest: z.string(),
  hostname: z.string(),
  validationSummary: z.string().max(4000).optional()
});

async function handleStudyPublish(rawPayload: z.infer<typeof studyPublishSchema>, request: NextRequest) {
  const payload = { ...rawPayload, validationSummary: readablePublishSummary(rawPayload.validationSummary) };
  const published = payload.stage === "published" && payload.phase === "Succeeded" && payload.imageDigest.includes("@sha256:");
  const deployment = await prisma.nvflareDeployment.findUnique({ where: { id: payload.deploymentId }, include: { study: true } });
  if (!deployment) return problem(404, "Deployment not found.", "not_found");

  // The stuck-pod watchdog may already have failed this run with a specific reason; keep it over the generic stop message.
  const existingRun = await prisma.cIValidationRun.findUnique({ where: { id: payload.ciRunId }, select: { status: true, summary: true } });
  const keepWatchdogReason = !published && existingRun?.status === "FAILED" && Boolean(existingRun.summary);
  const failureSummary = keepWatchdogReason ? existingRun!.summary! : payload.validationSummary;

  await prisma.$transaction(async (tx) => {
    await tx.cIValidationRun.update({
      where: { id: payload.ciRunId },
      data: { workflowId: payload.workflowId, status: published ? "PASSED" : "FAILED", summary: published ? payload.validationSummary : failureSummary, completedAt: new Date() }
    });
    await tx.pipelineVersion.update({
      where: { id: payload.pipelineVersionId },
      data: published
        ? { validationStatus: "PASSED", imageDigest: payload.imageDigest, imageRef: payload.imageDigest.split("@")[0], publishedAt: new Date() }
        : { validationStatus: "FAILED" }
    });
    if (published) {
      await tx.nvflareDeployment.updateMany({ where: { studyId: deployment.studyId, id: { not: deployment.id } }, data: { active: false } });
      await tx.nvflareDeployment.update({
        where: { id: deployment.id },
        data: {
          status: "ACTIVE",
          active: true,
          imageDigest: payload.imageDigest,
          pipelineVersionId: payload.pipelineVersionId,
          startedAt: deployment.startedAt ?? new Date(),
          lastError: null
        }
      });
    } else {
      // The aggregator keeps serving the previous version (if any); only the failure is recorded. If nothing
      // was ever published, the provisioning bookkeeping the publish route wrote ahead of the workflow must be
      // undone, otherwise the next publish skips kit provisioning for kits that were never produced.
      await tx.nvflareDeployment.update({
        where: { id: deployment.id },
        data: {
          lastError: failureSummary ?? "Publish failed.",
          ...(deployment.imageDigest ? {} : { kitGeneration: 0, provisionedSites: Prisma.JsonNull, clientKitPrefix: null })
        }
      });
    }
  });

  await audit({
    orgId: deployment.study.orgId,
    studyId: deployment.studyId,
    action: published ? "study.publish.succeeded" : "study.publish.failed",
    targetType: "NvflareDeployment",
    targetId: deployment.id,
    metadata: { workflowId: payload.workflowId, pipelineVersionId: payload.pipelineVersionId, imageDigest: payload.imageDigest, hostname: payload.hostname },
    request
  });
  return json({ ok: true });
}

function ciStatusForPhase(phase: string) {
  if (phase === "Running") return "RUNNING";
  if (phase === "Succeeded") return "PASSED";
  if (phase === "Failed" || phase === "Error") return "FAILED";
  return "QUEUED";
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const secret = process.env.ARGO_WEBHOOK_SECRET ?? "";
  if (secret && !verifyHmacSignature(secret, body, request.headers.get("x-fedlify-signature"))) {
    return problem(401, "Invalid webhook signature.", "unauthorized");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return problem(400, "Webhook body is not JSON.");
  }

  if ((raw as { kind?: unknown })?.kind === "study-publish") {
    // Publish callbacks switch what an aggregator serves; never accept them unsigned.
    if (!secret) return problem(503, "ARGO_WEBHOOK_SECRET is not configured.", "webhook_not_configured");
    const publish = studyPublishSchema.safeParse(raw);
    if (!publish.success) return problem(400, publish.error.issues[0]?.message ?? "Invalid publish callback.");
    return handleStudyPublish(publish.data, request);
  }

  const parsed = argoPayloadSchema.safeParse(raw);
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid Argo webhook.");

  let studyId: string | null = null;
  let orgId: string | null = null;

  if (parsed.data.ciRunId || parsed.data.pipelineVersionId) {
    const status = ciStatusForPhase(parsed.data.phase);
    const completedAt = status === "PASSED" || status === "FAILED" ? new Date() : null;
    const ciRun = parsed.data.ciRunId
      ? await prisma.cIValidationRun.update({
          where: { id: parsed.data.ciRunId },
          data: {
            workflowId: parsed.data.workflowId,
            status,
            summary: parsed.data.validationSummary,
            logsStorageKey: parsed.data.logsStorageKey,
            completedAt
          },
          include: { pipelineVersion: { include: { project: { include: { study: true } } } } }
        })
      : await prisma.cIValidationRun.create({
          data: {
            pipelineVersionId: parsed.data.pipelineVersionId,
            workflowId: parsed.data.workflowId,
            provider: "argo-gitea-publish",
            status,
            summary: parsed.data.validationSummary,
            logsStorageKey: parsed.data.logsStorageKey,
            completedAt
          },
          include: { pipelineVersion: { include: { project: { include: { study: true } } } } }
        });

    const pipelineVersion = ciRun.pipelineVersion;
    if (pipelineVersion) {
      await prisma.pipelineVersion.update({
        where: { id: pipelineVersion.id },
        data: { validationStatus: status }
      });
      studyId = pipelineVersion.project.studyId;
      orgId = pipelineVersion.project.study.orgId;
    }
  }

  await audit({
    orgId,
    studyId,
    action: "argo.webhook",
    targetType: "Workflow",
    targetId: parsed.data.workflowId,
    metadata: { phase: parsed.data.phase },
    request
  });

  return json({ ok: true });
}
