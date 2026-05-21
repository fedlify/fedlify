import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { startDockerComposeDeployment } from "@/lib/nvflare-runtime";
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

  const deployment = await prisma.nvflareDeployment.findFirst({
    where: { id: deploymentId, studyId },
    include: { study: { include: { studySites: { include: { site: true } } } } }
  });
  if (!deployment) return problem(404, "NVFLARE deployment not found.", "not_found");
  if (!deployment.serverAddress || !deployment.composeProject || !deployment.workspacePath || !deployment.ports) {
    return problem(409, "Provision the deployment before starting it.", "deployment_not_provisioned");
  }

  try {
    await startDockerComposeDeployment(deployment);
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "Docker start failed.";
    await prisma.nvflareDeployment.update({
      where: { id: deployment.id },
      data: { status: "PROVISIONED", active: false, lastError }
    });
    return problem(503, `Docker could not start the NVFLARE deployment: ${lastError}`, "docker_start_failed");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.nvflareDeployment.updateMany({ where: { studyId, id: { not: deployment.id } }, data: { active: false } });
    return tx.nvflareDeployment.update({
      where: { id: deployment.id },
      data: { status: "ACTIVE", active: true, startedAt: new Date(), stoppedAt: null, lastError: null }
    });
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: deployment.study.orgId,
    studyId,
    action: "nvflare.deployment.start",
    targetType: "NvflareDeployment",
    targetId: deployment.id,
    metadata: { serverAddress: deployment.serverAddress, composeProject: deployment.composeProject },
    request
  });

  return json({ deployment: updated });
}
