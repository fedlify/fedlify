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
import { checkPublishRun, type PublishLiveStatus } from "@/lib/workflow-watchdog";
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

  // Lazy watchdog: fail a publish whose pod cannot start. Runs before the reads below so the response reflects it.
  const live = new Map<string, PublishLiveStatus>();
  const inFlight = await prisma.cIValidationRun.findMany({
    where: { provider: "argo-study-publish", status: { in: ["QUEUED", "RUNNING"] }, workflowId: { not: null }, pipelineVersion: { project: { studyId } } },
    select: { id: true, pipelineVersionId: true, workflowId: true }
  });
  if (inFlight.length > 0) {
    const target = await prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" }, select: { id: true } });
    if (target) {
      // Parallel and bounded: a slow Kubernetes API must not hold up the status response.
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
      await Promise.all(
        inFlight.map(async (run) => {
          const status = await Promise.race([
            checkPublishRun({ ciRunId: run.id, pipelineVersionId: run.pipelineVersionId!, deploymentId: target.id, workflowId: run.workflowId! }).catch(() => null),
            timeout
          ]);
          if (status) live.set(run.id, status);
        })
      );
    }
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

  // Versions published from a commit that a person accepted from an assistant proposal are tagged "agent".
  const versionCommits = projects.flatMap((project) => project.versions.map((version) => version.gitCommit)).filter((commit): commit is string => Boolean(commit));
  const agentProposals = versionCommits.length
    ? await prisma.agentProposal.findMany({
        where: { projectId: { in: projects.map((project) => project.id) }, acceptedCommit: { in: versionCommits } },
        select: { id: true, projectId: true, title: true, acceptedCommit: true }
      })
    : [];

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
      // Where the project came from. Null for projects created before lineage was recorded (shown as "Template").
      sourceKind: project.sourceKind,
      sourceRef: project.sourceRef,
      parentProjectId: project.parentProjectId,
      parentVersion: project.parentVersion,
      versions: project.versions.map((version) => ({
        id: version.id,
        version: version.gitTag ?? version.version,
        gitCommit: version.gitCommit,
        agentProposal: agentProposals.find((item) => item.projectId === project.id && item.acceptedCommit === version.gitCommit) ?? null,
        imageDigest: version.imageDigest,
        validationStatus: version.validationStatus,
        publishedAt: version.publishedAt,
        publish: version.ciRuns[0]
          ? {
              status: version.ciRuns[0].status,
              summary: version.ciRuns[0].summary,
              workflowId: version.ciRuns[0].workflowId,
              step: live.get(version.ciRuns[0].id)?.step ?? null,
              stepState: live.get(version.ciRuns[0].id)?.stepState ?? null,
              waiting: live.get(version.ciRuns[0].id)?.waiting ?? null
            }
          : null
      }))
    })),
    jobs
  });
}
