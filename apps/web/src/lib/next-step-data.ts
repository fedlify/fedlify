/**
 * Server-side loading for the next-step resolver (next-step.ts): the study's ethics decision, study questions,
 * the Code & run overview, readiness sign-offs, model releases and the person's permissions.
 */
import { loadAggregatorOverview } from "@/lib/aggregator-overview";
import { prisma } from "@/lib/prisma";
import { canAccessStudyActions, type StudyAction } from "@/lib/rbac";
import { resolveStudySteps, type StepPermissions, type StepsResult, type StepsSnapshot } from "@/lib/next-step";
import { ethicsSnapshot, loadQuestionProgress } from "@/lib/preflight-data";
import { siteSignedOff } from "@/lib/site-signoff";

/** The permissions the steps ask about. */
export const STEP_PERMISSIONS: StudyAction[] = ["manageEthics", "manage", "runAgent", "approvePipeline", "manageSites", "submitJob", "approveRelease"];

export async function loadStepPermissions(studyId: string, userId: string): Promise<StepPermissions> {
  return canAccessStudyActions(userId, studyId, STEP_PERMISSIONS);
}

export async function loadStepsSnapshot(studyId: string, userId?: string): Promise<StepsSnapshot> {
  const [study, questions, overview, readiness, modelReleases] = await Promise.all([
    prisma.study.findUnique({ where: { id: studyId }, select: { title: true, goal: true, status: true, ethics: { orderBy: { createdAt: "desc" }, take: 1 } } }),
    loadQuestionProgress(studyId),
    // Summary only reads: it skips the publish watchdog, which can write. Code & run still runs it.
    loadAggregatorOverview(studyId, { watchdog: false }),
    prisma.studySite.findMany({
      where: { studyId, participationStatus: { not: "DISABLED" } },
      select: {
        id: true,
        readinessChecks: { orderBy: { createdAt: "desc" }, take: 1 },
        ...(userId ? { members: { where: { userId }, select: { id: true } } } : {})
      }
    }),
    prisma.modelRelease.count({ where: { studyId } })
  ]);
  const signedOff = new Map(readiness.map((site) => [site.id, siteSignedOff(site.readinessChecks[0])]));
  return {
    studyId,
    study: { title: study?.title, goal: study?.goal, status: study?.status ?? "DRAFT" },
    ethics: ethicsSnapshot(study?.ethics),
    questions,
    hasProject: overview.projects.length > 0,
    versions: overview.projects.flatMap((project) => project.versions.map((version) => ({ id: version.id, version: version.version, gitCommit: version.gitCommit, publish: version.publish }))),
    aggregator: overview.aggregator,
    sites: overview.sites.map((site) => ({ ...site, signedOff: signedOff.get(site.studySiteId) ?? false })),
    jobs: overview.jobs.map((job) => ({ id: job.id, status: job.status, result: job.result })),
    modelReleases,
    mySiteIds: userId ? readiness.filter((site) => "members" in site && Array.isArray(site.members) && site.members.length > 0).map((site) => site.id) : []
  };
}

export async function loadStudySteps(studyId: string, userId: string): Promise<StepsResult> {
  const [snapshot, can] = await Promise.all([loadStepsSnapshot(studyId, userId), loadStepPermissions(studyId, userId)]);
  return resolveStudySteps(snapshot, can);
}
