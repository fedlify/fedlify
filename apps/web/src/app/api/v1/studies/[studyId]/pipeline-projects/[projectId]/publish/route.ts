/**
 * POST /api/v1/studies/[studyId]/pipeline-projects/[projectId]/publish
 *
 * Publish = freeze a saved commit as v<N>, build the study image, and bring the study aggregator up at
 * <slug>.fedlify.com:443 (Argo workflow fedlify-study-publish). Progress arrives on /api/webhooks/argo.
 */

import { z } from "zod";
import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { submitStudyPublishWorkflow } from "@/lib/agent";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ensureGiteaTag, getGiteaBranch, GiteaApiError, isRuntimeConfigurationError } from "@/lib/gitea";
import { ethicsCleared, latestEthicsStatus, requirementsGate } from "@/lib/governance";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import {
  clientKitPrefix,
  nvflareClientName,
  studyAdapterUrl,
  studyHostname,
  studyNamespace,
  studyRuntimeSlug
} from "@/lib/study-runtime";

const PUBLISH_PROVIDER = "argo-study-publish";

const publishSchema = z.object({
  commit: z.string().trim().regex(/^[a-f0-9]{7,64}$/i).optional(),
  notes: z.string().trim().max(2000).optional()
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

function sameSites(a: unknown, b: Array<{ name: string }>): boolean {
  if (!Array.isArray(a)) return false;
  const left = a.map((site) => String((site as { name?: string }).name)).sort();
  const right = b.map((site) => site.name).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, projectId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "approvePipeline");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = publishSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid publish request.");

  const [study, project] = await Promise.all([
    prisma.study.findUnique({
      where: { id: studyId },
      include: {
        ethics: { orderBy: { createdAt: "desc" }, take: 1 },
        studySites: { where: { participationStatus: { not: "DISABLED" } }, include: { site: true }, orderBy: { code: "asc" } }
      }
    }),
    prisma.pipelineProject.findUnique({ where: { id: projectId }, include: { versions: { select: { id: true } } } })
  ]);
  if (!study) return problem(404, "Study not found.", "not_found");
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline project not found for this study.", "not_found");
  if (!project.giteaOwner || !project.giteaRepo) return problem(409, "Save the project to Gitea before publishing.", "gitea_repo_required");

  // Governance gates: the same ones that guard code generation and job execution.
  const missing: string[] = [];
  if (!ethicsCleared(latestEthicsStatus(study.ethics))) missing.push("ethicsApproval");
  const requirements = requirementsGate(await prisma.requirementResponse.findMany({ where: { studyId }, select: { requirementId: true } }));
  if (!requirements.allowed) missing.push(`requirements (${requirements.missing.join(", ")})`);
  if (study.studySites.length === 0) missing.push("studySites");
  if (missing.length > 0) return problem(409, `Publishing is blocked by missing requirements: ${missing.join("; ")}.`, "publish_gate");

  const inFlight = await prisma.cIValidationRun.findFirst({
    where: { provider: PUBLISH_PROVIDER, status: { in: ["QUEUED", "RUNNING"] }, pipelineVersion: { projectId } }
  });
  if (inFlight) return problem(409, "A publish is already in progress for this project.", "publish_in_progress");

  const deployment = await prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" } });
  if (deployment) {
    const running = await prisma.nvflareJob.count({ where: { deploymentId: deployment.id, status: { in: ["SUBMITTED", "SCHEDULED", "RUNNING"] } } });
    if (running > 0) return problem(409, "A run is in progress on the aggregator; wait for it to finish or abort it before republishing.", "run_in_progress");
  }

  // Resolve and freeze the commit.
  let commitSha: string;
  try {
    const branch = await getGiteaBranch({ owner: project.giteaOwner, repo: project.giteaRepo, branchName: project.defaultBranch });
    commitSha = parsed.data.commit ?? branch.commit?.id ?? branch.commit?.sha ?? "";
    if (!commitSha) return problem(409, "The project branch has no commits yet.", "no_commits");
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const existingVersion = await prisma.pipelineVersion.findFirst({ where: { projectId, gitCommit: { startsWith: commitSha } } });
  const versionTag = existingVersion?.gitTag ?? `v${project.versions.length + 1}`;
  try {
    await ensureGiteaTag({
      owner: project.giteaOwner,
      repo: project.giteaRepo,
      tagName: versionTag,
      commitSha: existingVersion?.gitCommit ?? commitSha,
      message: parsed.data.notes ?? `Published from Fedlify by ${authResult.userId}`
    });
  } catch (error) {
    if (error instanceof GiteaApiError) return problem(error.status === 409 ? 409 : 502, error.message, "gitea_tag_failed");
    throw error;
  }

  // Stable runtime identity for the study: hostname, namespace, adapter.
  const sites = study.studySites.map((studySite) => ({ name: nvflareClientName({ code: studySite.code, nvflareClientName: studySite.site?.nvflareClientName }) }));
  let target = deployment;
  if (!target) {
    // Hostname policy: <study-slug>-<study id suffix>. Study titles are not unique across accounts and every
    // account starts with a default study, so the bare slug would go to whoever publishes first, and a study
    // titled "harbor" or "git" could claim a platform hostname. The suffix rules out both. The name is fixed
    // at first publish, so renaming a study later never breaks the site kits already issued.
    const runtimeSlug = studyRuntimeSlug(study.slug, studyId.slice(-6).toLowerCase());
    target = await prisma.nvflareDeployment.create({
      data: {
        studyId,
        name: `${study.title} aggregator`,
        runtimeMode: "k8s",
        hostname: studyHostname(runtimeSlug),
        namespace: studyNamespace(runtimeSlug),
        adapterUrl: studyAdapterUrl(runtimeSlug),
        serverAddress: `${studyHostname(runtimeSlug)}:443`,
        status: "DRAFT"
      }
    });
  }
  const runtimeSlug = target.namespace!.replace(/^study-/, "");
  const provision = target.kitGeneration === 0 || !sameSites(target.provisionedSites, sites);
  const kitGeneration = provision ? target.kitGeneration + 1 : target.kitGeneration;

  const { version, ciRun } = await prisma.$transaction(async (tx) => {
    const version = existingVersion
      ? await tx.pipelineVersion.update({
          where: { id: existingVersion.id },
          data: { validationStatus: "QUEUED", gitTag: versionTag }
        })
      : await tx.pipelineVersion.create({
          data: {
            projectId,
            templateId: project.templateId,
            templateVersionId: project.templateVersionId ?? undefined,
            version: versionTag,
            gitTag: versionTag,
            gitCommit: commitSha,
            gitBranch: project.defaultBranch,
            validationStatus: "QUEUED",
            approvalStatus: "APPROVED",
            approvedById: authResult.userId,
            approvedAt: new Date(),
            immutable: true
          }
        });
    const ciRun = await tx.cIValidationRun.create({
      data: { pipelineVersionId: version.id, provider: PUBLISH_PROVIDER, status: "QUEUED", summary: `Publishing ${versionTag} to ${target!.hostname}.` }
    });
    await tx.nvflareDeployment.update({
      where: { id: target!.id },
      data: {
        pipelineVersionId: version.id,
        kitGeneration,
        ...(provision
          ? { provisionedSites: sites as Prisma.InputJsonArray, clientKitPrefix: clientKitPrefix(studyId, target!.id), status: "DRAFT" }
          : {}),
        lastError: null
      }
    });
    return { version, ciRun };
  });

  try {
    const submitted = await submitStudyPublishWorkflow({
      pipelineVersionId: version.id,
      ciRunId: ciRun.id,
      deploymentId: target.id,
      studyId,
      runtimeSlug,
      hostname: target.hostname!,
      giteaOwner: project.giteaOwner,
      giteaRepo: project.giteaRepo,
      gitCommit: version.gitCommit!,
      versionTag,
      sites,
      provision,
      kitGeneration
    });
    await prisma.$transaction([
      prisma.cIValidationRun.update({ where: { id: ciRun.id }, data: { workflowId: submitted.workflowId, status: "RUNNING" } }),
      prisma.pipelineVersion.update({ where: { id: version.id }, data: { publishWorkflowId: submitted.workflowId, validationStatus: "RUNNING" } })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish workflow submission failed.";
    await prisma.$transaction([
      prisma.cIValidationRun.update({ where: { id: ciRun.id }, data: { status: "FAILED", summary: message, completedAt: new Date() } }),
      prisma.pipelineVersion.update({ where: { id: version.id }, data: { validationStatus: "FAILED" } }),
      prisma.nvflareDeployment.update({ where: { id: target.id }, data: { lastError: message } })
    ]);
    return problem(503, message, "publish_submit_failed");
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "pipeline_project.publish",
    targetType: "PipelineVersion",
    targetId: version.id,
    metadata: { versionTag, gitCommit: version.gitCommit, hostname: target.hostname, provision, kitGeneration, sites: sites.map((site) => site.name) },
    request
  });

  return json(
    {
      pipelineVersion: { id: version.id, version: versionTag, gitCommit: version.gitCommit },
      deployment: { id: target.id, hostname: target.hostname, kitGeneration, provision },
      ciRun: { id: ciRun.id }
    },
    { status: 202 }
  );
}
