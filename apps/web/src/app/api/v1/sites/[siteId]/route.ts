import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, canAccessSite, canAccessStudy, isForbiddenError } from "@/lib/rbac";
import { markStaleSitesOffline } from "@/lib/site-presence";
import { SITE_ONBOARDING_STEPS } from "@/lib/site-onboarding";
import { summarizeSiteRuntime } from "@/lib/site-runtime";
import { adapterSystemInfo, nvflareClientName } from "@/lib/study-runtime";

export async function GET(_request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const owner = await prisma.studySite.findUnique({ where: { id: siteId }, select: { studyId: true } });
  if (owner) await markStaleSitesOffline(owner.studyId);

  const studySite = await prisma.studySite.findUnique({
    where: { id: siteId },
    include: {
      study: {
        select: {
          id: true,
          title: true,
          description: true,
          goal: true,
          researchQuestion: true,
          clinicalUseCase: true,
          population: true,
          dataModalities: true,
          primaryOutcome: true,
          riskLevel: true,
          intendedUse: true,
          governanceStatus: true,
          status: true,
          organization: { select: { id: true, name: true } }
        }
      },
      site: {
        include: {
          heartbeats: { orderBy: { createdAt: "desc" }, take: 5 }
        }
      },
      organization: { select: { id: true, name: true } },
      resourceProfile: true,
      dataProfile: true,
      readinessChecks: { orderBy: { createdAt: "desc" }, take: 5 },
      joinPackages: { omit: { downloadGrantHash: true, downloadGrantExpiresAt: true }, orderBy: { createdAt: "desc" }, take: 5 },
      nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 5 },
      logArtifacts: { orderBy: { createdAt: "desc" }, take: 10 }
    }
  });

  if (!studySite) return problem(404, "Site not found.", "not_found");

  // A person with access to this one site (and no study access) sees only this site's history, not other sites' events.
  const studyWide = await canAccessStudy(authResult.userId, studySite.studyId, "read");
  const auditFilters = [
    { targetId: siteId },
    ...(studySite.siteId ? [{ targetId: studySite.siteId }] : []),
    ...(studyWide ? [{ action: { startsWith: "site." } }] : [])
  ];
  const canSeeInvitations = await canAccessSite(authResult.userId, siteId, "assignMembers");
  // Everyone on the site list is visible to study readers and to site administrators; anyone else sees only themselves.
  const members = await prisma.siteMember.findMany({
    where: { studySiteId: siteId, ...(studyWide || canSeeInvitations ? {} : { userId: authResult.userId }) },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" }
  });
  const pendingInvitations = canSeeInvitations
    ? await prisma.invitation.findMany({
        where: { studySiteId: siteId, status: "PENDING", expiresAt: { gt: new Date() } },
        select: { id: true, email: true, siteRoles: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: "desc" }
      })
    : [];

  const pipelineWhere = {
    project: { studyId: studySite.studyId },
    validationStatus: "PASSED" as const,
    approvalStatus: { in: ["VALIDATED" as const, "APPROVED" as const] }
  };
  const [approvedReleases, pipelineVersions, activeDeployment, auditEvents] = await Promise.all([
    studyWide
      ? prisma.kitRelease.findMany({
          where: { studyId: studySite.studyId, status: "APPROVED" },
          include: { artifacts: true },
          orderBy: { approvedAt: "desc" }
        })
      : // A site-only person gets the release names and the files meant for every site or for this site: no storage keys.
        prisma.kitRelease.findMany({
          where: { studyId: studySite.studyId, status: "APPROVED" },
          select: {
            id: true,
            version: true,
            approvedAt: true,
            artifacts: {
              where: { OR: [{ siteId: null }, ...(studySite.siteId ? [{ siteId: studySite.siteId }] : [])] },
              select: { id: true, kind: true, filename: true, siteId: true }
            }
          },
          orderBy: { approvedAt: "desc" }
        }),
    studyWide
      ? prisma.pipelineVersion.findMany({
          where: pipelineWhere,
          include: { project: { include: { template: true } }, ciRuns: { orderBy: { startedAt: "desc" }, take: 3 } },
          orderBy: { createdAt: "desc" }
        })
      : prisma.pipelineVersion.findMany({
          where: pipelineWhere,
          select: { id: true, version: true, gitCommit: true, validationStatus: true, approvalStatus: true, createdAt: true },
          orderBy: { createdAt: "desc" }
        }),
    prisma.nvflareDeployment.findFirst({ where: { studyId: studySite.studyId, active: true }, orderBy: { updatedAt: "desc" } }),
    prisma.auditEvent.findMany({
      where: {
        studyId: studySite.studyId,
        OR: auditFilters
      },
      orderBy: { createdAt: "desc" },
      take: 25
    })
  ]);

  const clientName = nvflareClientName({ code: studySite.code, nvflareClientName: studySite.site?.nvflareClientName });
  let listedByAggregator: boolean | null = null;
  if (activeDeployment?.status === "ACTIVE") {
    try {
      listedByAggregator = (await adapterSystemInfo({ studyId: studySite.studyId, adapterUrl: activeDeployment.adapterUrl })).clients.some((client) => client.name === clientName);
    } catch {
      // The page shows the connection as unknown.
    }
  }
  const liveVersion = activeDeployment?.pipelineVersionId
    ? await prisma.pipelineVersion.findUnique({ where: { id: activeDeployment.pipelineVersionId }, select: { id: true, version: true, gitCommit: true } })
    : null;
  const activeKit = studySite.joinPackages.find((item) => item.status === "ACTIVE" && item.expiresAt > new Date()) ?? null;
  const runtime = summarizeSiteRuntime({
    code: studySite.code,
    clientName,
    deployment: activeDeployment,
    liveVersion,
    activeKit,
    heartbeat: studySite.site?.heartbeats[0] ?? null,
    listedByAggregator
  });

  return json({
    onboardingSteps: SITE_ONBOARDING_STEPS,
    studySite: { ...studySite, members },
    pendingInvitations,
    // The study server's addresses, storage keys and the other sites stay with the study team.
    activeDeployment: studyWide || !activeDeployment
      ? activeDeployment
      : { id: activeDeployment.id, status: activeDeployment.status, pipelineVersionId: activeDeployment.pipelineVersionId, updatedAt: activeDeployment.updatedAt },
    runtime,
    approvedReleases,
    pipelineVersions,
    auditEvents
  });
}
