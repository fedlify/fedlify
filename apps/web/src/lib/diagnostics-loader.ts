/**
 * Loads the diagnostics context for one project: database rows, the latest publish workflow from the in-cluster API,
 * and per-site connection and kit state. Read-only. Every external call is bounded in time and size, and every piece
 * of text goes through diagnostics.ts before it leaves this module. Failures degrade to a note, never an exception.
 */

import { getPodLogTail, getWorkflowDiagnostics } from "@/lib/agent";
import {
  boundDiagnostics,
  DIAGNOSTICS_LIMITS,
  firstErrorLines,
  sanitizeLog,
  sanitizeMessage,
  selectFailedPod,
  selectFailedStep,
  selectSteps,
  SITE_SIDE_NOTE,
  type DiagnosticsContext
} from "@/lib/diagnostics";
import { prisma } from "@/lib/prisma";
import { adapterSystemInfo, nvflareClientName } from "@/lib/study-runtime";

const PUBLISH_PROVIDER = "argo-study-publish";
const CLUSTER_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

type PublishDiag = NonNullable<DiagnosticsContext["publish"]>;

async function loadPublish(projectId: string): Promise<DiagnosticsContext["publish"]> {
  const run = await prisma.cIValidationRun.findFirst({
    where: { provider: PUBLISH_PROVIDER, pipelineVersion: { projectId } },
    orderBy: { startedAt: "desc" },
    include: { pipelineVersion: { select: { version: true, gitCommit: true } } }
  });
  if (!run) return null;

  const publish: PublishDiag = {
    id: run.id,
    version: run.pipelineVersion?.version ?? null,
    commit: run.pipelineVersion?.gitCommit?.slice(0, 12) ?? null,
    status: run.status,
    summary: run.summary ? sanitizeMessage(run.summary, DIAGNOSTICS_LIMITS.summaryChars) : null,
    workflowPhase: null,
    steps: [],
    failedStep: null,
    firstErrorLines: [],
    logTail: null,
    logNote: null
  };
  if (!run.workflowId) return publish;
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    publish.logNote = "The workflow cannot be read from this environment (no cluster access).";
    return publish;
  }

  const snapshot = await withTimeout(getWorkflowDiagnostics(run.workflowId).catch(() => null), CLUSTER_TIMEOUT_MS);
  if (!snapshot) {
    publish.logNote = "The workflow could not be read (it may have been cleaned up, or the cluster did not answer).";
    return publish;
  }
  publish.workflowPhase = snapshot.phase;
  publish.steps = selectSteps(snapshot.nodes, run.workflowId);
  const failed = selectFailedStep(publish.steps);
  publish.failedStep = failed?.step ?? null;
  if (failed?.message) publish.firstErrorLines = [failed.message];

  if (run.status === "FAILED" && failed) {
    const pod = selectFailedPod(snapshot.pods, failed.step, run.workflowId);
    if (!pod) {
      publish.logNote = "The failed step's pod no longer exists, so its log is not available.";
    } else {
      const raw = await withTimeout(
        getPodLogTail(pod, { tailLines: DIAGNOSTICS_LIMITS.fetchTailLines, limitBytes: DIAGNOSTICS_LIMITS.fetchBytes }).catch(() => null),
        CLUSTER_TIMEOUT_MS
      );
      if (raw === null) {
        publish.logNote = "The log of the failed step could not be read.";
      } else {
        const log = sanitizeLog(raw);
        publish.logTail = log.text || null;
        publish.logNote = log.notes.length ? log.notes.join("; ") : null;
        const lines = firstErrorLines(log.text);
        if (lines.length > 0) publish.firstErrorLines = lines;
      }
    }
  }
  if (publish.firstErrorLines.length === 0 && publish.summary) publish.firstErrorLines = [publish.summary];
  return publish;
}

export async function loadProjectDiagnostics(studyId: string, projectId: string): Promise<DiagnosticsContext> {
  const notes: string[] = [];
  const publish = await loadPublish(projectId).catch(() => {
    notes.push("The latest publish could not be loaded.");
    return null;
  });

  const [deployment, studySites] = await Promise.all([
    prisma.nvflareDeployment.findFirst({ where: { studyId, runtimeMode: "k8s" } }),
    prisma.studySite.findMany({
      where: { studyId, participationStatus: { not: "DISABLED" } },
      include: {
        site: true,
        joinPackages: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 },
        nvflareStatuses: { orderBy: { observedAt: "desc" }, take: 1 }
      },
      orderBy: { code: "asc" },
      take: DIAGNOSTICS_LIMITS.sites
    })
  ]);

  let connected: string[] | null = null;
  let reachable: boolean | null = null;
  if (deployment?.status === "ACTIVE") {
    const info = await withTimeout(adapterSystemInfo({ studyId, adapterUrl: deployment.adapterUrl }).catch(() => null), 3000);
    connected = info ? info.clients.map((client) => client.name) : null;
    reachable = info !== null;
    if (!info) notes.push("The aggregator did not answer, so site connection state is unknown.");
  }

  const provisioned = new Set(
    Array.isArray(deployment?.provisionedSites) ? (deployment.provisionedSites as Array<{ name?: string }>).map((site) => String(site.name)) : []
  );
  const sites = studySites.map((studySite) => {
    const name = nvflareClientName({ code: studySite.code, nvflareClientName: studySite.site?.nvflareClientName });
    const kit = studySite.joinPackages[0];
    const observed = studySite.nvflareStatuses[0];
    return {
      code: studySite.code,
      name: studySite.name,
      participation: studySite.participationStatus,
      observedStatus: observed?.status ?? null,
      observedAt: observed?.observedAt.toISOString() ?? null,
      connected: connected ? connected.includes(name) : null,
      provisioned: provisioned.has(name),
      kitReleased: Boolean(kit),
      kitMatchesLiveImage: kit && deployment?.imageDigest ? kit.imageDigest === deployment.imageDigest : null
    };
  });

  const job = deployment
    ? await prisma.nvflareJob.findFirst({
        where: { deploymentId: deployment.id },
        orderBy: { createdAt: "desc" },
        include: { events: { orderBy: { createdAt: "desc" }, take: DIAGNOSTICS_LIMITS.events, include: { studySite: { select: { code: true } } } } }
      })
    : null;

  return boundDiagnostics({
    publish,
    aggregator: deployment ? { status: deployment.status, reachable, lastError: deployment.lastError, kitGeneration: deployment.kitGeneration } : null,
    run: job
      ? {
          id: job.id,
          status: job.status,
          nvflareJobId: job.nvflareJobId,
          submittedAt: job.submittedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
          events: job.events
            .slice()
            .reverse()
            .map((event) => ({ type: event.eventType, site: event.studySite?.code ?? null, message: event.message ?? "", at: event.createdAt.toISOString() }))
        }
      : null,
    sites,
    notes,
    siteSideNote: SITE_SIDE_NOTE
  });
}
