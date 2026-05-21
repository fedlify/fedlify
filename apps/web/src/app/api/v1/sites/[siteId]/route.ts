import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { SITE_ONBOARDING_STEPS } from "@/lib/site-onboarding";

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
      organization: true,
      resourceProfile: true,
      dataProfile: true,
      members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "desc" } },
      readinessChecks: { orderBy: { createdAt: "desc" }, take: 5 },
      joinPackages: { orderBy: { createdAt: "desc" }, take: 5 },
      nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 5 },
      logArtifacts: { orderBy: { createdAt: "desc" }, take: 10 }
    }
  });

  if (!studySite) return problem(404, "Participant site not found.", "not_found");

  const auditFilters = [
    { targetId: siteId },
    ...(studySite.siteId ? [{ targetId: studySite.siteId }] : []),
    { action: { startsWith: "site." } }
  ];

  const [approvedReleases, pipelineVersions, activeDeployment, auditEvents] = await Promise.all([
    prisma.kitRelease.findMany({
      where: { studyId: studySite.studyId, status: "APPROVED" },
      include: { artifacts: true },
      orderBy: { approvedAt: "desc" }
    }),
    prisma.pipelineVersion.findMany({
      where: {
        project: { studyId: studySite.studyId },
        validationStatus: "PASSED",
        approvalStatus: { in: ["VALIDATED", "APPROVED"] }
      },
      include: {
        project: { include: { template: true } },
        ciRuns: { orderBy: { startedAt: "desc" }, take: 3 }
      },
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

  return json({
    onboardingSteps: SITE_ONBOARDING_STEPS,
    studySite,
    activeDeployment,
    approvedReleases,
    pipelineVersions,
    auditEvents
  });
}
