import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { collectModelResultArtifacts, resultStoragePrefix } from "@/lib/model-results";
import { downloadNvflareJobResult } from "@/lib/nvflare";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";

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

  try {
    await assertStudyAccess(authResult.userId, job.studyId, "viewLogs");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (job.status !== "COMPLETED") {
    return problem(409, "Only completed NVFLARE jobs can be synced as model results.", "job_not_completed");
  }
  if (!job.nvflareJobId) return problem(409, "The Fedlify job does not have an NVFLARE job id.", "nvflare_job_missing");
  if (!job.deployment?.adminStartupPath) {
    return problem(409, "The job deployment does not have an admin startup kit path for result download.", "admin_startup_missing");
  }
  if (job.result?.artifacts.length) return json({ result: job.result, alreadySynced: true });

  const storagePrefix = resultStoragePrefix(job.studyId, job.id);
  let collected: Awaited<ReturnType<typeof collectModelResultArtifacts>>;
  const uploadedKeys: string[] = [];

  try {
    const downloaded = await downloadNvflareJobResult({
      nvflareJobId: job.nvflareJobId,
      adminStartupPath: job.deployment.adminStartupPath
    });
    collected = await collectModelResultArtifacts({
      resultPath: downloaded.resultPath,
      studyId: job.studyId,
      jobId: job.id,
      nvflareJobId: job.nvflareJobId,
      pipelineVersionId: job.pipelineVersionId,
      storagePrefix
    });

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
