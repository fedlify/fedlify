import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { getNvflareSystemInfo } from "@/lib/nvflare";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "viewLogs");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const [siteStatuses, runningJobCount, deployment] = await Promise.all([
    prisma.nvflareSiteStatus.findMany({
      where: { studySite: { studyId } },
      include: { studySite: true },
      orderBy: { observedAt: "desc" },
      take: 100
    }),
    prisma.nvflareJob.count({ where: { studyId, status: { in: ["SUBMITTED", "SCHEDULED", "RUNNING"] } } }),
    prisma.nvflareDeployment.findFirst({ where: { studyId, active: true }, orderBy: { updatedAt: "desc" } })
  ]);

  const latestBySite = new Map<string, (typeof siteStatuses)[number]>();
  for (const status of siteStatuses) {
    if (!latestBySite.has(status.studySiteId)) latestBySite.set(status.studySiteId, status);
  }

  const systemInfo = await getNvflareSystemInfo({
    studyId,
    connectedSiteCount: Array.from(latestBySite.values()).filter((status) => status.status === "CONNECTED").length,
    runningJobCount,
    deployment
  });

  return json({ systemInfo, deployment, siteStatuses: Array.from(latestBySite.values()) });
}
