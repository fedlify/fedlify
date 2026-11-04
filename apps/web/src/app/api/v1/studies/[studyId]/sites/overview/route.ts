/** GET /api/v1/studies/[studyId]/sites/overview: one row per participant site for the merged Sites table. Read access. */
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { markStaleSitesOffline } from "@/lib/site-presence";
import { kitState, type SiteOverviewRow } from "@/lib/site-overview";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  await markStaleSitesOffline(studyId);
  const [deployment, studySites] = await Promise.all([
    prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" }, select: { imageDigest: true } }),
    prisma.studySite.findMany({
      where: { studyId },
      select: {
        id: true,
        code: true,
        name: true,
        institutionName: true,
        participationStatus: true,
        readinessChecks: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
        nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 1, select: { status: true } },
        joinPackages: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1, select: { imageDigest: true } },
        site: { select: { heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } } }
      },
      orderBy: { code: "asc" }
    })
  ]);

  const sites: SiteOverviewRow[] = studySites.map((site) => ({
    studySiteId: site.id,
    code: site.code,
    name: site.name,
    institutionName: site.institutionName,
    readiness: site.readinessChecks[0]?.status ?? "PENDING",
    kitState: kitState(site.joinPackages[0], deployment?.imageDigest),
    connection: site.nvflareStatuses[0]?.status ?? site.participationStatus,
    lastHeartbeatAt: site.site?.heartbeats[0]?.createdAt.toISOString() ?? null
  }));
  return json({ sites }, { headers: { "Cache-Control": "no-store" } });
}
