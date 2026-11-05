/**
 * GET /api/v1/nvflare/jobs/[jobId]/progress
 *
 * Live view of a run on a published study aggregator: NVFLARE job status (persisted to the job record
 * when it changes) plus per-round, per-site metrics. Only aggregate metrics leave the sites.
 */

import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { captureRunMetrics } from "@/lib/run-reconcile";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { adapterJobMeta, adapterJobMetrics, fedlifyJobStatus, StudyRuntimeError, summarizeRoundMetrics } from "@/lib/study-runtime";

const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED", "REJECTED"]);

export async function GET(_request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { jobId } = await context.params;

  const job = await prisma.nvflareJob.findUnique({ where: { id: jobId }, include: { deployment: true } });
  if (!job) return problem(404, "NVFLARE job not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, job.studyId, "viewLogs");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }
  if (job.deployment?.runtimeMode !== "k8s") return problem(409, "Live progress is available for published study aggregators.", "not_published_runtime");
  if (!job.nvflareJobId) return json({ job, nvflareStatus: null, rounds: [] });

  const target = { studyId: job.studyId, adapterUrl: job.deployment.adapterUrl };
  let nvflareStatus: string;
  let rounds: ReturnType<typeof summarizeRoundMetrics>;
  let metricsSource: string;
  try {
    const [meta, metrics] = await Promise.all([adapterJobMeta(target, job.nvflareJobId), adapterJobMetrics(target, job.nvflareJobId)]);
    nvflareStatus = meta.status;
    rounds = summarizeRoundMetrics(metrics.records);
    metricsSource = metrics.source;
  } catch (error) {
    if (error instanceof StudyRuntimeError) return problem(error.status, error.message, "aggregator_unreachable");
    throw error;
  }

  let current = job;
  const status = fedlifyJobStatus(nvflareStatus);
  if (!TERMINAL.has(job.status) && status !== job.status) {
    current = await prisma.$transaction(async (tx) => {
      const updated = await tx.nvflareJob.update({
        where: { id: job.id },
        data: { status, ...(TERMINAL.has(status) ? { completedAt: new Date() } : {}) },
        include: { deployment: true }
      });
      await tx.nvflareJobEvent.create({
        data: {
          jobId: job.id,
          studyId: job.studyId,
          eventType: status === "RUNNING" ? "STARTED" : status,
          message: `NVFLARE reports ${nvflareStatus}${rounds.length ? ` after ${rounds.length} round(s)` : ""}.`,
          metadata: { nvflareStatus, rounds: rounds.length } as Prisma.InputJsonObject
        }
      });
      return updated;
    });
  }

  // Keep the per-round metrics once the run is over, whether or not anyone saves the model.
  if (TERMINAL.has(current.status)) await captureRunMetrics(current);

  return json({ job: current, nvflareStatus, metricsSource, rounds });
}
