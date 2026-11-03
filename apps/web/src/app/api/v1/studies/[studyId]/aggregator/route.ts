/**
 * GET /api/v1/studies/[studyId]/aggregator
 *
 * Everything the study's pipeline view needs in one call: the published aggregator (hostname, version,
 * publish status), which sites are actually connected to it, published versions, and recent runs.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { adapterSystemInfo, nvflareClientName, StudyRuntimeError } from "@/lib/study-runtime";

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

  const [deployment, studySites, projects] = await Promise.all([
    prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" } }),
    prisma.studySite.findMany({
      where: { studyId, participationStatus: { not: "DISABLED" } },
      include: { site: true, joinPackages: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { code: "asc" }
    }),
    prisma.pipelineProject.findMany({
      where: { studyId },
      include: {
        versions: {
          where: { gitTag: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { ciRuns: { where: { provider: "argo-study-publish" }, orderBy: { startedAt: "desc" }, take: 1 } }
        }
      },
      orderBy: { updatedAt: "desc" }
    })
  ]);

  let connected: string[] | null = null;
  let aggregatorError: string | null = null;
  if (deployment?.status === "ACTIVE") {
    try {
      connected = (await adapterSystemInfo({ studyId, adapterUrl: deployment.adapterUrl })).clients.map((client) => client.name);
    } catch (error) {
      aggregatorError = error instanceof StudyRuntimeError ? error.message : "Aggregator status unavailable.";
    }
  }

  const provisioned = new Set(
    Array.isArray(deployment?.provisionedSites) ? (deployment.provisionedSites as Array<{ name?: string }>).map((site) => String(site.name)) : []
  );
  const sites = studySites.map((studySite) => {
    const name = nvflareClientName({ code: studySite.code, nvflareClientName: studySite.site?.nvflareClientName });
    const kit = studySite.joinPackages[0];
    return {
      studySiteId: studySite.id,
      code: studySite.code,
      name: studySite.name,
      institutionName: studySite.institutionName,
      nvflareClientName: name,
      provisioned: provisioned.has(name),
      kitReleased: Boolean(kit),
      kitImageDigest: kit?.imageDigest ?? null,
      connected: connected ? connected.includes(name) : null
    };
  });

  const jobs = deployment
    ? await prisma.nvflareJob.findMany({
        where: { deploymentId: deployment.id },
        include: { pipelineVersion: { select: { id: true, version: true, gitCommit: true } }, result: { select: { id: true } } },
        orderBy: { createdAt: "desc" },
        take: 10
      })
    : [];

  return json({
    aggregator: deployment
      ? {
          id: deployment.id,
          hostname: deployment.hostname,
          status: deployment.status,
          active: deployment.active,
          imageDigest: deployment.imageDigest,
          pipelineVersionId: deployment.pipelineVersionId,
          kitGeneration: deployment.kitGeneration,
          lastError: deployment.lastError,
          startedAt: deployment.startedAt,
          reachable: deployment.status === "ACTIVE" ? aggregatorError === null : null,
          error: aggregatorError
        }
      : null,
    sites,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      giteaRepoUrl: project.giteaRepoUrl,
      defaultBranch: project.defaultBranch,
      versions: project.versions.map((version) => ({
        id: version.id,
        version: version.gitTag ?? version.version,
        gitCommit: version.gitCommit,
        imageDigest: version.imageDigest,
        validationStatus: version.validationStatus,
        publishedAt: version.publishedAt,
        publish: version.ciRuns[0]
          ? { status: version.ciRuns[0].status, summary: version.ciRuns[0].summary, workflowId: version.ciRuns[0].workflowId }
          : null
      }))
    })),
    jobs
  });
}
