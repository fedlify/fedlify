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
import { HarborError } from "@/lib/harbor-registry";
import { ensureStudyRegistryProject, registryMode } from "@/lib/registry-access";
import { evaluatePreflight, type PreflightItem, type PreflightSnapshot } from "@/lib/preflight";
import { ethicsSnapshot, loadPublishBusyState, loadQuestionProgress, publishSnapshotSites, PUBLISH_PROVIDER } from "@/lib/preflight-data";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { clientKitPrefix, nvflareClientName, studyAdapterUrl, studyHostname, studyNamespace, studyRuntimeSlug } from "@/lib/study-runtime";

class PublishBusyError extends Error {}

const publishSchema = z.object({
  commit: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{7,64}$/i)
    .optional(),
  notes: z.string().trim().max(2000).optional()
});

type Params = { params: Promise<{ studyId: string; projectId: string }> };

function sameSites(a: unknown, b: Array<{ name: string }>): boolean {
  if (!Array.isArray(a)) return false;
  const left = a.map((site) => String((site as { name?: string }).name)).sort();
  const right = b.map((site) => site.name).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** A plain 409 in the usual error shape, with the checklist added under details. */
function problemWithItems(status: number, message: string, code: string, items: PreflightItem[]) {
  return json({ error: { code, message, details: { items } } }, { status });
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
        studySites: {
          where: { participationStatus: { not: "DISABLED" } },
          include: { site: true },
          orderBy: { code: "asc" }
        }
      }
    }),
    prisma.pipelineProject.findUnique({
      where: { id: projectId },
      include: { versions: { select: { id: true } } }
    })
  ]);
  if (!study) return problem(404, "Study not found.", "not_found");
  if (!project || project.studyId !== studyId) return problem(404, "Pipeline not found for this study.", "not_found");

  // The same checklist the screen shows (see lib/preflight.ts), decided in stages because the later checks cost more.
  const snapshot: PreflightSnapshot = {
    studyId,
    ethics: ethicsSnapshot(study.ethics),
    questions: await loadQuestionProgress(studyId),
    sites: publishSnapshotSites(study.studySites)
  };
  if (!project.giteaOwner || !project.giteaRepo) {
    const unsaved = evaluatePreflight("publish", {
      ...snapshot,
      savedCode: false
    });
    return problemWithItems(409, "Save the pipeline before publishing.", "gitea_repo_required", unsaved.items);
  }
  const gate = evaluatePreflight("publish", snapshot);
  if (!gate.ok) {
    const failing = gate.items.filter((item) => !item.ok);
    const messages = failing.map((item) => item.text);
    const missing = failing.map((item) => (item.code === "ethics" ? "ethicsApproval" : item.code === "study_questions" ? "requirements" : "studySites"));
    return json(
      {
        error: {
          code: "publish_gate",
          message: `Publishing is not possible yet. ${messages.join(". ")}.`,
          details: { missing, steps: messages, items: gate.items }
        }
      },
      { status: 409 }
    );
  }

  const busy = await loadPublishBusyState(studyId, projectId);
  const deployment = busy.deployment;
  const refuse = (items: PreflightItem[], code: string, message: string) => problemWithItems(409, message, code, items);
  const busyGate = evaluatePreflight("publish", {
    ...snapshot,
    publishInProgress: busy.publishInProgress,
    runInProgress: busy.runInProgress
  });
  if (!busyGate.ok) {
    const publishing = busyGate.items.some((item) => item.code === "publish_idle" && !item.ok);
    return publishing
      ? refuse(busyGate.items, "publish_in_progress", "A publish is already in progress for this pipeline.")
      : refuse(busyGate.items, "run_in_progress", "A run is in progress on the study server; wait for it to finish or stop it before publishing again.");
  }

  // Resolve and freeze the commit.
  let commitSha: string;
  try {
    const branch = await getGiteaBranch({
      owner: project.giteaOwner,
      repo: project.giteaRepo,
      branchName: project.defaultBranch
    });
    commitSha = parsed.data.commit ?? branch.commit?.id ?? branch.commit?.sha ?? "";
    const saved = evaluatePreflight("publish", {
      ...snapshot,
      publishInProgress: false,
      runInProgress: false,
      savedCode: Boolean(commitSha)
    });
    if (!saved.ok) return refuse(saved.items, "no_commits", "This pipeline has no saved code yet. Save it first.");
  } catch (error) {
    if (isRuntimeConfigurationError(error)) return problem(503, error.message, "gitea_not_configured");
    if (error instanceof GiteaApiError) return problem(502, error.message, "gitea_api_error");
    throw error;
  }

  const existingVersion = await prisma.pipelineVersion.findFirst({
    where: { projectId, gitCommit: { startsWith: commitSha } }
  });
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
  const sites = study.studySites.map((studySite) => ({
    name: nvflareClientName({
      code: studySite.code,
      nvflareClientName: studySite.site?.nvflareClientName
    })
  }));
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

  // Per-study registry mode: the study's private Harbor project must exist (and be ours) before anything is built. A
  // failure stops here, before a version or run is recorded, and never falls back to the shared project.
  let registryProject: string | null = null;
  if (registryMode() === "per-study") {
    try {
      registryProject = (
        await ensureStudyRegistryProject({
          studyId,
          runtimeSlug,
          actorUserId: authResult.userId,
          orgId: study.orgId
        })
      ).name;
    } catch (error) {
      if (error instanceof HarborError) {
        const status = error.code === "not_configured" ? 503 : error.code === "conflict" ? 409 : 502;
        return problem(status, error.message, error.code === "not_configured" ? "registry_not_configured" : error.code === "conflict" ? "registry_project_conflict" : "registry_unavailable");
      }
      throw error;
    }
  }
  const provision = target.kitGeneration === 0 || !sameSites(target.provisionedSites, sites);
  const kitGeneration = provision ? target.kitGeneration + 1 : target.kitGeneration;

  let created: {
    version: Awaited<ReturnType<typeof prisma.pipelineVersion.update>>;
    ciRun: Awaited<ReturnType<typeof prisma.cIValidationRun.create>>;
  };
  try {
    created = await prisma.$transaction(async (tx) => {
      // Check again inside the transaction: a second publish that started after the check above must not run beside this one.
      const concurrent = await tx.cIValidationRun.findFirst({
        where: {
          provider: PUBLISH_PROVIDER,
          status: { in: ["QUEUED", "RUNNING"] },
          pipelineVersion: { projectId }
        },
        select: { id: true }
      });
      if (concurrent) throw new PublishBusyError();
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
        data: {
          pipelineVersionId: version.id,
          provider: PUBLISH_PROVIDER,
          status: "QUEUED",
          summary: `Publishing ${versionTag} to ${target!.hostname}.`
        }
      });
      await tx.nvflareDeployment.update({
        where: { id: target!.id },
        data: {
          // pipelineVersionId is what the aggregator serves: only the success callback may move it.
          kitGeneration,
          ...(provision
            ? {
                provisionedSites: sites as Prisma.InputJsonArray,
                clientKitPrefix: clientKitPrefix(studyId, target!.id),
                status: "DRAFT"
              }
            : {}),
          lastError: null
        }
      });
      return { version, ciRun };
    });
  } catch (error) {
    if (error instanceof PublishBusyError) {
      const items = evaluatePreflight("publish", {
        ...snapshot,
        savedCode: true,
        publishInProgress: true,
        runInProgress: false
      }).items;
      return problemWithItems(409, "A publish is already in progress for this pipeline.", "publish_in_progress", items);
    }
    throw error;
  }
  const { version, ciRun } = created;

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
      kitGeneration,
      registryProject
    });
    await prisma.$transaction([
      prisma.cIValidationRun.update({
        where: { id: ciRun.id },
        data: { workflowId: submitted.workflowId, status: "RUNNING" }
      }),
      prisma.pipelineVersion.update({
        where: { id: version.id },
        data: {
          publishWorkflowId: submitted.workflowId,
          validationStatus: "RUNNING"
        }
      })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publishing could not be started. Try again.";
    await prisma.$transaction([
      prisma.cIValidationRun.update({
        where: { id: ciRun.id },
        data: { status: "FAILED", summary: message, completedAt: new Date() }
      }),
      prisma.pipelineVersion.update({
        where: { id: version.id },
        data: { validationStatus: "FAILED" }
      }),
      prisma.nvflareDeployment.update({
        where: { id: target.id },
        data: { lastError: message }
      })
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
    metadata: {
      versionTag,
      gitCommit: version.gitCommit,
      hostname: target.hostname,
      registryProject,
      provision,
      kitGeneration,
      sites: sites.map((site) => site.name)
    },
    request
  });

  return json(
    {
      pipelineVersion: {
        id: version.id,
        version: versionTag,
        gitCommit: version.gitCommit
      },
      deployment: {
        id: target.id,
        hostname: target.hostname,
        kitGeneration,
        provision
      },
      ciRun: { id: ciRun.id }
    },
    { status: 202 }
  );
}
