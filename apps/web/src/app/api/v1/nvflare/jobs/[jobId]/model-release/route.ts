import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import {
  collectModelResultArtifacts,
  modelReleaseChecksum,
  modelReleaseStoragePrefix,
  nextModelReleaseVersion
} from "@/lib/model-results";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { objectKey, storageConfigured, uploadObject } from "@/lib/storage";

const promoteSchema = z.object({
  status: z.enum(["DRAFT", "APPROVED"]).default("APPROVED"),
  releaseNotes: z.string().trim().max(4000).optional()
});

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { jobId } = await context.params;

  const parsed = promoteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid model release request.");

  const job = await prisma.nvflareJob.findUnique({
    where: { id: jobId },
    include: {
      study: true,
      pipelineVersion: { include: { project: true } },
      result: { include: { artifacts: true, modelRelease: { include: { artifacts: true } } } }
    }
  });
  if (!job) return problem(404, "NVFLARE job not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, job.studyId, "approveRelease");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (job.status !== "COMPLETED") return problem(409, "Only completed NVFLARE jobs can be promoted.", "job_not_completed");
  if (job.pipelineVersion.approvalStatus !== "APPROVED") {
    return problem(409, "Only jobs run from approved pipeline versions can be promoted.", "pipeline_not_approved");
  }
  if (!job.result) return problem(409, "Sync the completed job result before promoting it to a model release.", "result_required");
  if (job.result.modelRelease) return json({ modelRelease: job.result.modelRelease, alreadyPromoted: true });
  if (!job.result.artifacts.some((artifact) => artifact.kind === "AGGREGATED_MODEL")) {
    return problem(409, "The synced result does not include an aggregated model artifact.", "model_artifact_required");
  }
  if (!job.result.resultPath) {
    return problem(409, "The synced result does not have a local result path. Sync the result again before promotion.", "result_path_required");
  }

  const existingVersions = await prisma.modelRelease.findMany({
    where: { studyId: job.studyId },
    select: { version: true }
  });
  const version = nextModelReleaseVersion(existingVersions.map((release) => release.version));
  const storagePrefix = modelReleaseStoragePrefix(job.studyId, version);
  let collected: Awaited<ReturnType<typeof collectModelResultArtifacts>>;
  try {
    collected = await collectModelResultArtifacts({
      resultPath: job.result.resultPath,
      studyId: job.studyId,
      jobId: job.id,
      nvflareJobId: job.nvflareJobId,
      pipelineVersionId: job.pipelineVersionId,
      storagePrefix
    });
  } catch (error) {
    return problem(
      409,
      error instanceof Error ? error.message : "The synced result could not be prepared for model release.",
      "model_result_unavailable"
    );
  }
  const checksum = modelReleaseChecksum({
    version,
    sourceResultId: job.result.id,
    modelChecksum: collected.artifacts.find((artifact) => artifact.kind === "AGGREGATED_MODEL")?.checksum,
    artifactChecksums: collected.artifacts.map((artifact) => [artifact.filename, artifact.checksum])
  });

  const uploadedKeys: string[] = [];
  try {
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
      error instanceof Error ? error.message : "The model release artifacts could not be stored.",
      "model_release_storage_failed"
    );
  }

  const modelRelease = await prisma.$transaction(async (tx) => {
    const created = await tx.modelRelease.create({
      data: {
        studyId: job.studyId,
        sourceResultId: job.result!.id,
        createdById: authResult.userId,
        approvedById: parsed.data.status === "APPROVED" ? authResult.userId : null,
        approvedAt: parsed.data.status === "APPROVED" ? new Date() : null,
        version,
        status: parsed.data.status,
        checksum,
        storagePrefix,
        releaseNotes: parsed.data.releaseNotes,
        immutable: parsed.data.status === "APPROVED",
        artifacts: {
          create: collected.artifacts.map((artifact) => ({
            resultId: job.result!.id,
            kind: artifact.kind,
            filename: artifact.filename,
            contentType: artifact.contentType,
            storageKey: objectKey([storagePrefix, artifact.filename]),
            checksum: artifact.checksum,
            sizeBytes: artifact.sizeBytes
          }))
        }
      },
      include: {
        artifacts: true,
        sourceResult: { include: { job: { include: { pipelineVersion: { include: { project: true } } } } } }
      }
    });

    await tx.nvflareJobEvent.create({
      data: {
        jobId: job.id,
        studyId: job.studyId,
        eventType: "LOG_AVAILABLE",
        message: `Model result promoted to ${version}.`,
        metadata: {
          modelReleaseId: created.id,
          version,
          status: created.status,
          storagePrefix,
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
    action: "model_release.promote",
    targetType: "ModelRelease",
    targetId: modelRelease.id,
    metadata: {
      version,
      status: modelRelease.status,
      sourceResultId: job.result.id,
      jobId: job.id,
      nvflareJobId: job.nvflareJobId,
      pipelineVersionId: job.pipelineVersionId,
      checksum
    },
    request
  });

  if (modelRelease.status === "APPROVED") {
    await audit({
      actorUserId: authResult.userId,
      orgId: job.study.orgId,
      studyId: job.studyId,
      action: "model_release.approve",
      targetType: "ModelRelease",
      targetId: modelRelease.id,
      metadata: {
        version,
        sourceResultId: job.result.id,
        jobId: job.id,
        nvflareJobId: job.nvflareJobId,
        pipelineVersionId: job.pipelineVersionId,
        checksum
      },
      request
    });
  }

  return json({ modelRelease }, { status: 201 });
}
