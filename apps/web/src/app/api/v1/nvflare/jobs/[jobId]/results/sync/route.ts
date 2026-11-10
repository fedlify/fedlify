import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { collectModelResultArtifacts, resultStoragePrefix, roundMetricsArtifact } from "@/lib/model-results";
import { unzipToArchiveMap } from "@/lib/archive";
import { downloadNvflareJobResult } from "@/lib/nvflare";
import { prisma } from "@/lib/prisma";
import { canSaveRunModel } from "@/lib/run-evidence";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";
import { adapterJobMetrics, adapterJobResultZip } from "@/lib/study-runtime";
import { parseRoundMetricsJsonl, recordsToJsonl, summarizeMetrics } from "@/lib/round-metrics";

// Published studies: the adapter returns the NVFLARE result as a zip; unpack it so the existing
// model-artifact collection runs unchanged. The caller removes the returned directory.
async function downloadPublishedResult(input: { studyId: string; adapterUrl: string | null; nvflareJobId: string }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fedlify-result-"));
  const files = await unzipToArchiveMap(await adapterJobResultZip({ studyId: input.studyId, adapterUrl: input.adapterUrl }, input.nvflareJobId));
  for (const [relative, body] of Object.entries(files)) {
    const destination = path.join(root, relative);
    if (!destination.startsWith(root + path.sep)) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body);
  }
  return root;
}

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { jobId } = await context.params;

  const job = await prisma.nvflareJob.findUnique({
    where: { id: jobId },
    include: {
      study: true,
      deployment: true,
      pipelineVersion: { include: { project: true } },
      result: { include: { artifacts: true, modelRelease: { include: { artifacts: true } } } }
    }
  });
  if (!job) return problem(404, "NVFLARE job not found.", "not_found");

  // Same rule as the Save model button on the run page.
  if (!(await canSaveRunModel(authResult.userId, job.studyId))) {
    return problem(403, "Only study managers and release approvers can save a model.", "forbidden");
  }

  if (job.status !== "COMPLETED") {
    return problem(409, "Only completed NVFLARE jobs can be synced as model results.", "job_not_completed");
  }
  if (!job.nvflareJobId) return problem(409, "The Fedlify job does not have an NVFLARE job id.", "nvflare_job_missing");
  const publishedRuntime = job.deployment?.runtimeMode === "k8s";
  if (!publishedRuntime && !job.deployment?.adminStartupPath) {
    return problem(409, "The job deployment does not have an admin startup kit path for result download.", "admin_startup_missing");
  }
  if (job.result?.artifacts.length) return json({ result: job.result, alreadySynced: true });

  const storagePrefix = resultStoragePrefix(job.studyId, job.id);
  let collected: Awaited<ReturnType<typeof collectModelResultArtifacts>>;
  const uploadedKeys: string[] = [];
  let temporaryResultDir: string | null = null;

  try {
    const resultPath = publishedRuntime
      ? (temporaryResultDir = await downloadPublishedResult({ studyId: job.studyId, adapterUrl: job.deployment!.adapterUrl, nvflareJobId: job.nvflareJobId }))
      : (await downloadNvflareJobResult({ nvflareJobId: job.nvflareJobId, adminStartupPath: job.deployment!.adminStartupPath })).resultPath;
    collected = await collectModelResultArtifacts({
      resultPath,
      studyId: job.studyId,
      jobId: job.id,
      nvflareJobId: job.nvflareJobId,
      pipelineVersionId: job.pipelineVersionId,
      storagePrefix
    });

    // The result zip normally carries fedlify_metrics.jsonl. If it does not (older image), keep what the aggregator
    // still has in its run directory so the numbers are stored with the model rather than lost.
    if (publishedRuntime && !collected.artifacts.some((artifact) => artifact.kind === "ROUND_METRICS")) {
      if (job.metricsJsonl) {
        collected.artifacts.push(roundMetricsArtifact(Buffer.from(job.metricsJsonl)));
      } else try {
        const live = await adapterJobMetrics({ studyId: job.studyId, adapterUrl: job.deployment!.adapterUrl }, job.nvflareJobId);
        if (live.records.length) collected.artifacts.push(roundMetricsArtifact(Buffer.from(recordsToJsonl(live.records))));
      } catch {
        // Missing metrics are shown as missing on the run page; they never block saving the model.
      }
    }

    if (storageConfigured()) {
      for (const artifact of collected.artifacts) {
        const key = objectKey([storagePrefix, artifact.filename]);
        await uploadObject(key, artifact.body, artifact.contentType);
        uploadedKeys.push(key);
      }
    }
  } catch (error) {
    return problem(
      502,
      error instanceof Error ? error.message : "The completed NVFLARE result could not be synced.",
      "result_sync_failed"
    );
  } finally {
    if (temporaryResultDir) await rm(temporaryResultDir, { recursive: true, force: true });
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.nvflareJobResult.create({
      data: {
        studyId: job.studyId,
        jobId: job.id,
        syncedById: authResult.userId,
        resultPath: collected.resultPath,
        storagePrefix,
        checksum: collected.checksum,
        modelPath: collected.modelPath,
        modelShape: collected.modelShape as Prisma.InputJsonValue,
        modelDtype: collected.modelDtype,
        modelSizeBytes: collected.modelSizeBytes,
        manifest: collected.manifest as Prisma.InputJsonObject,
        artifacts: {
          create: collected.artifacts.map((artifact) => ({
            kind: artifact.kind,
            filename: artifact.filename,
            contentType: artifact.contentType,
            storageKey: objectKey([storagePrefix, artifact.filename]),
            checksum: artifact.checksum,
            sizeBytes: artifact.sizeBytes
          }))
        }
      },
      include: { artifacts: true, modelRelease: { include: { artifacts: true } } }
    });

    const metricsArtifact = collected.artifacts.find((artifact) => artifact.kind === "ROUND_METRICS");
    if (metricsArtifact) {
      const summary = summarizeMetrics(parseRoundMetricsJsonl(metricsArtifact.body.toString("utf8")));
      await tx.nvflareJob.update({ where: { id: job.id }, data: { metricsSummary: summary as unknown as Prisma.InputJsonObject } });
    }

    await tx.nvflareJobEvent.create({
      data: {
        jobId: job.id,
        studyId: job.studyId,
        eventType: "LOG_AVAILABLE",
        message: "Aggregated model result synced into Fedlify.",
        metadata: {
          resultId: created.id,
          resultPath: collected.resultPath,
          modelPath: collected.modelPath,
          artifactCount: collected.artifacts.length,
          storageConfigured: storageConfigured(),
          uploadedKeys
        } as Prisma.InputJsonObject
      }
    });

    return created;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: job.study.orgId,
    studyId: job.studyId,
    action: "nvflare.job_result.sync",
    targetType: "NvflareJobResult",
    targetId: result.id,
    metadata: {
      jobId: job.id,
      nvflareJobId: job.nvflareJobId,
      pipelineVersionId: job.pipelineVersionId,
      storagePrefix,
      artifactCount: result.artifacts.length
    },
    request
  });

  return json({ result }, { status: 201 });
}
