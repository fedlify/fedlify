/**
 * Server-side loading for the preflight checklist (preflight.ts) and the shared queries the publish route, the
 * run-start route and the aggregator overview all use, so each query exists once.
 */
import { latestEthicsStatus, latestEthicsValidUntil, requirementsGate } from "@/lib/governance";
import { getGiteaBranch } from "@/lib/gitea";
import { prisma } from "@/lib/prisma";
import { canAccessStudy } from "@/lib/rbac";
import { effectiveControlMode } from "@/lib/runtime-config";
import { evaluateSecondApprover } from "@/lib/publish-approval";
import { REQUIREMENT_ORDER } from "@/lib/requirements-catalog";
import { checkSiteImages } from "@/lib/site-image";
import { isSitePresent } from "@/lib/site-presence";
import { siteSignedOff } from "@/lib/site-signoff";
import { ADAPTER_STATUS_TIMEOUT_MS, adapterSystemInfo, nvflareClientName, StudyRuntimeError } from "@/lib/study-runtime";
import { evaluatePreflight, type PreflightKind, type PreflightResult, type PreflightSite, type PreflightSnapshot } from "@/lib/preflight";

export const PUBLISH_PROVIDER = "argo-study-publish";
export const ACTIVE_JOB_STATUSES = ["SUBMITTED", "SCHEDULED", "RUNNING"] as const;

/** Latest heartbeat of a site: when it arrived and what it reported. Shared by every query that shows connection state. */
export const LATEST_HEARTBEAT_INCLUDE = { heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, metadata: true } } } as const;

type EthicsRows = Parameters<typeof latestEthicsStatus>[0];

export function ethicsSnapshot(ethics: EthicsRows): PreflightSnapshot["ethics"] {
  const status = latestEthicsStatus(ethics);
  return status ? { status, validUntil: latestEthicsValidUntil(ethics) } : null;
}

/** How many of the study questions are answered. */
export async function loadQuestionProgress(studyId: string): Promise<{ answered: number; total: number }> {
  const responses = await prisma.requirementResponse.findMany({ where: { studyId }, select: { requirementId: true } });
  return questionProgress(responses);
}

export function questionProgress(responses: Array<{ requirementId: string }>): { answered: number; total: number } {
  const gate = requirementsGate(responses);
  return { answered: REQUIREMENT_ORDER.length - gate.missing.length, total: REQUIREMENT_ORDER.length };
}

/** Is a publish already running for the pipeline, and is a run running on the study server? */
export async function loadPublishBusyState(studyId: string, projectId: string) {
  const publishRun = await prisma.cIValidationRun.findFirst({
    where: { provider: PUBLISH_PROVIDER, status: { in: ["QUEUED", "RUNNING"] }, pipelineVersion: { projectId } }
  });
  const deployment = await prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" } });
  const running = deployment
    ? await prisma.nvflareJob.count({ where: { deploymentId: deployment.id, status: { in: [...ACTIVE_JOB_STATUSES] } } })
    : 0;
  return { publishInProgress: Boolean(publishRun), runInProgress: running > 0, deployment };
}

/** The latest saved commit of a pipeline: null when nothing is saved, "unchecked" when the code host cannot be reached. */
export async function findSavedCommit(project: { giteaOwner: string | null; giteaRepo: string | null; defaultBranch: string }): Promise<string | null | "unchecked"> {
  if (!project.giteaOwner || !project.giteaRepo) return null;
  try {
    const branch = await getGiteaBranch({ owner: project.giteaOwner, repo: project.giteaRepo, branchName: project.defaultBranch });
    return branch?.commit?.id ?? branch?.commit?.sha ?? null;
  } catch {
    return "unchecked";
  }
}

type SiteRowForPublish = { id: string; siteId?: string | null; code: string; name: string };

/** Publish only needs to know how many sites take part. */
export function publishSnapshotSites(studySites: SiteRowForPublish[]): PreflightSite[] {
  return studySites.map((site) => ({ studySiteId: site.id, siteId: site.id, code: site.code, name: site.name, signedOff: false, connected: null, imageState: null }));
}

/** Everything the run checks need about one study, loaded with the same queries the run-start route always used. */
export async function loadRunContext(studyId: string, input: { pipelineVersionId?: string | null; studySiteIds?: string[] }) {
  const deployment = await prisma.nvflareDeployment.findFirst({ where: { studyId, active: true, status: "ACTIVE" } });
  const pipelineVersionId = input.pipelineVersionId ?? deployment?.pipelineVersionId ?? null;
  const [study, pipelineVersion] = await Promise.all([
    prisma.study.findUnique({ where: { id: studyId }, include: { ethics: { orderBy: { createdAt: "desc" }, take: 1 } } }),
    pipelineVersionId ? prisma.pipelineVersion.findUnique({ where: { id: pipelineVersionId }, include: { project: true } }) : Promise.resolve(null)
  ]);
  const studySites = await prisma.studySite.findMany({
    where: {
      studyId,
      // A disabled site neither blocks nor takes part in a run.
      participationStatus: { not: "DISABLED" },
      ...(input.studySiteIds?.length ? { id: { in: input.studySiteIds } } : {})
    },
    include: { readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 }, site: { include: LATEST_HEARTBEAT_INCLUDE } }
  });
  // A publish restarts the study server and a run uses it: neither may start while the other is going on.
  const [publishRun, runningJobs] = await Promise.all([
    prisma.cIValidationRun.findFirst({ where: { provider: PUBLISH_PROVIDER, status: { in: ["QUEUED", "RUNNING"] }, pipelineVersion: { project: { studyId } } }, select: { id: true } }),
    prisma.nvflareJob.count({ where: { studyId, status: { in: [...ACTIVE_JOB_STATUSES] } } })
  ]);
  return { study, pipelineVersion, studySites, deployment, busy: { publishInProgress: Boolean(publishRun), runInProgress: runningJobs > 0 } };
}

export type RunContext = Awaited<ReturnType<typeof loadRunContext>>;

/** Names of the clients the study server lists as connected. Throws StudyRuntimeError when it cannot be asked. */
export async function fetchConnectedClients(studyId: string, deployment: { adapterUrl: string | null }): Promise<Set<string>> {
  const info = await adapterSystemInfo({ studyId, adapterUrl: deployment.adapterUrl }, { timeoutMs: ADAPTER_STATUS_TIMEOUT_MS });
  return new Set(info.clients.map((client) => client.name));
}

/**
 * The run snapshot. `connected` is the study server's client list: a Set when known, null when it has not been
 * asked yet (connection items are then left out), and "unreachable" when it could not be asked.
 */
export function runPreflightSnapshot(
  studyId: string,
  ctx: RunContext,
  options: { connected: Set<string> | null | "unreachable"; minClients?: number | null; now?: Date }
): PreflightSnapshot {
  const { study, pipelineVersion, studySites, deployment } = ctx;
  const published = deployment?.runtimeMode === "k8s";
  const connectedSet = options.connected instanceof Set ? options.connected : null;
  const images = published
    ? new Map(
        checkSiteImages(
          studySites.map((site) => ({
            code: site.code,
            clientName: nvflareClientName({ code: site.code, nvflareClientName: site.site?.nvflareClientName }),
            name: site.name,
            heartbeatMetadata: site.site?.heartbeats[0]?.metadata ?? null
          })),
          deployment?.imageDigest
        ).map((check) => [check.code, check.state] as const)
      )
    : null;
  return {
    studyId,
    now: options.now,
    ethics: ethicsSnapshot(study?.ethics),
    questions: { answered: 0, total: 0 },
    sites: studySites.map((site) => ({
      studySiteId: site.id,
      siteId: site.id,
      code: site.code,
      name: site.name,
      signedOff: siteSignedOff(site.readinessChecks[0]),
      connected:
        published && connectedSet
          ? isSitePresent(connectedSet.has(nvflareClientName({ code: site.code, nvflareClientName: site.site?.nvflareClientName })), site.site?.heartbeats[0]?.createdAt)
          : null,
      imageState: images?.get(site.code) ?? null
    })),
    pipeline: {
      exists: Boolean(pipelineVersion),
      approved: pipelineVersion?.approvalStatus === "APPROVED",
      checksPassed: pipelineVersion?.validationStatus === "PASSED"
    },
    studyServer: {
      running: Boolean(deployment?.serverAddress),
      servesPipeline: Boolean(deployment && pipelineVersion && (!published || deployment.pipelineVersionId === pipelineVersion.id))
    },
    serverUnreachable: published && options.connected === "unreachable",
    publishInProgress: ctx.busy.publishInProgress,
    runInProgress: ctx.busy.runInProgress,
    minSites: options.minClients ?? null
  };
}

/** The checklist for Publish or Start run, as the server would decide it right now. Run snapshots leave the study questions out. */
export async function loadPreflight(
  studyId: string,
  kind: PreflightKind,
  options: { projectId?: string | null; studySiteIds?: string[]; pipelineVersionId?: string | null; minClients?: number | null; commit?: string | null; /** The person who would publish. Enforced studies add the second-approver item for them. */ publisherId?: string | null } = {}
): Promise<PreflightResult> {
  if (kind === "run") {
    const ctx = await loadRunContext(studyId, { pipelineVersionId: options.pipelineVersionId, studySiteIds: options.studySiteIds });
    let connected: Set<string> | null | "unreachable" = null;
    if (ctx.deployment?.runtimeMode === "k8s") {
      try {
        connected = await fetchConnectedClients(studyId, ctx.deployment);
      } catch (error) {
        if (!(error instanceof StudyRuntimeError)) throw error;
        connected = "unreachable";
      }
    }
    return evaluatePreflight("run", runPreflightSnapshot(studyId, ctx, { connected, minClients: options.minClients }));
  }

  const [study, project, questions] = await Promise.all([
    prisma.study.findUnique({
      where: { id: studyId },
      include: {
        ethics: { orderBy: { createdAt: "desc" }, take: 1 },
        studySites: { where: { participationStatus: { not: "DISABLED" } }, include: { site: true }, orderBy: { code: "asc" } }
      }
    }),
    options.projectId ? prisma.pipelineProject.findUnique({ where: { id: options.projectId } }) : Promise.resolve(null),
    loadQuestionProgress(studyId)
  ]);
  const validProject = project && project.studyId === studyId ? project : null;
  const busy = validProject ? await loadPublishBusyState(studyId, validProject.id) : null;
  // A commit the caller names (the publish route accepts one) counts as saved code, as it does for the route.
  const saved = validProject ? (options.commit ? options.commit : await findSavedCommit(validProject)) : null;
  // Enforced studies only: will the person publishing need a second approver? Left out for anyone who may not publish.
  let secondApprover: PreflightSnapshot["secondApprover"] = null;
  if (validProject && options.publisherId && effectiveControlMode(studyId) === "enforce" && (await canAccessStudy(options.publisherId, studyId, "approvePipeline"))) {
    const check = await evaluateSecondApprover({ studyId, projectId: validProject.id, publisherId: options.publisherId });
    secondApprover = { required: check.required, names: check.others.map((other) => other.name) };
  }
  return evaluatePreflight("publish", {
    studyId,
    ethics: ethicsSnapshot(study?.ethics),
    questions,
    sites: publishSnapshotSites(study?.studySites ?? []),
    savedCode: saved !== "unchecked" && Boolean(saved),
    ...(saved === "unchecked" ? { savedCodeUnchecked: true } : {}),
    publishInProgress: busy?.publishInProgress ?? false,
    runInProgress: busy?.runInProgress ?? false,
    ...(secondApprover ? { secondApprover } : {})
  });
}
