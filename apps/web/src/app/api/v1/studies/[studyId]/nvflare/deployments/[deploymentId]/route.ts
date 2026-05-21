import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string; deploymentId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, deploymentId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const deployment = await prisma.nvflareDeployment.findFirst({
    where: { id: deploymentId, studyId },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 10 }, siteStatuses: { orderBy: { observedAt: "desc" }, take: 20 } }
  });
  if (!deployment) return problem(404, "NVFLARE deployment not found.", "not_found");
  return json({ deployment });
}
