import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { stopDockerComposeDeployment } from "@/lib/nvflare-runtime";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string; deploymentId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, deploymentId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "submitJob");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const deployment = await prisma.nvflareDeployment.findFirst({ where: { id: deploymentId, studyId }, include: { study: true } });
  if (!deployment) return problem(404, "NVFLARE deployment not found.", "not_found");

  let lastError: string | null = null;
  try {
    await stopDockerComposeDeployment(deployment);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Docker stop failed.";
  }

  const updated = await prisma.nvflareDeployment.update({
    where: { id: deployment.id },
    data: { status: "PAUSED", active: false, stoppedAt: new Date(), lastError }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: deployment.study.orgId,
    studyId,
    action: "nvflare.deployment.stop",
    targetType: "NvflareDeployment",
    targetId: deployment.id,
    metadata: { lastError },
    request
  });

  return json({ deployment: updated });
}
