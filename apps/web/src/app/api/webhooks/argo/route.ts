import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { verifyHmacSignature } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";

const argoPayloadSchema = z.object({
  agentRunId: z.string().optional(),
  computeRunId: z.string().optional(),
  workflowId: z.string(),
  phase: z.enum(["Pending", "Running", "Succeeded", "Failed", "Error"]),
  logsStorageKey: z.string().optional(),
  validationSummary: z.string().optional(),
  artifacts: z
    .array(
      z.object({
        releaseId: z.string().optional(),
        kind: z.enum(["SERVER_KIT", "SITE_KIT", "ADMIN_KIT", "HELM_CHART", "SOURCE_BUNDLE", "CHECKSUM_MANIFEST", "SIGNATURE", "LOG_BUNDLE"]),
        siteId: z.string().optional(),
        filename: z.string(),
        contentType: z.string(),
        storageKey: z.string(),
        checksum: z.string(),
        sizeBytes: z.number().int().min(0)
      })
    )
    .optional()
});

function agentStatusForPhase(phase: string) {
  if (phase === "Running") return "RUNNING";
  if (phase === "Succeeded") return "VALIDATED";
  if (phase === "Failed" || phase === "Error") return "FAILED";
  return "QUEUED";
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const secret = process.env.ARGO_WEBHOOK_SECRET ?? "";
  if (secret && !verifyHmacSignature(secret, body, request.headers.get("x-fedlify-signature"))) {
    return problem(401, "Invalid webhook signature.", "unauthorized");
  }

  const parsed = argoPayloadSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid Argo webhook.");

  let studyId: string | null = null;
  let orgId: string | null = null;

  if (parsed.data.agentRunId) {
    const updated = await prisma.agentRun.update({
      where: { id: parsed.data.agentRunId },
      data: {
        workflowId: parsed.data.workflowId,
        status: agentStatusForPhase(parsed.data.phase),
        logsStorageKey: parsed.data.logsStorageKey,
        validationSummary: parsed.data.validationSummary
      },
      include: { study: true }
    });
    studyId = updated.studyId;
    orgId = updated.study.orgId;
  }

  if (parsed.data.computeRunId) {
    const status =
      parsed.data.phase === "Succeeded"
        ? "SUCCEEDED"
        : parsed.data.phase === "Failed" || parsed.data.phase === "Error"
          ? "FAILED"
          : parsed.data.phase === "Running"
            ? "RUNNING"
            : "QUEUED";
    const updated = await prisma.computeRun.update({
      where: { id: parsed.data.computeRunId },
      data: {
        workflowId: parsed.data.workflowId,
        status,
        completedAt: status === "SUCCEEDED" || status === "FAILED" ? new Date() : null
      },
      include: { study: true }
    });
    studyId = updated.studyId;
    orgId = updated.study.orgId;
  }

  if (parsed.data.artifacts?.length) {
    for (const artifact of parsed.data.artifacts) {
      if (!artifact.releaseId) continue;
      await prisma.kitArtifact.create({
        data: {
          releaseId: artifact.releaseId,
          kind: artifact.kind,
          siteId: artifact.siteId,
          filename: artifact.filename,
          contentType: artifact.contentType,
          storageKey: artifact.storageKey,
          checksum: artifact.checksum,
          sizeBytes: BigInt(artifact.sizeBytes)
        }
      });
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
