import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { canAccessAnyStudySite, canAccessStudy } from "@/lib/rbac";
import { createPresignedDownloadUrl, storageConfigured } from "@/lib/storage";

export async function GET(request: NextRequest, context: { params: Promise<{ pipelineVersionId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { pipelineVersionId } = await context.params;

  const version = await prisma.pipelineVersion.findUnique({
    where: { id: pipelineVersionId },
    include: { project: { include: { study: true } } }
  });
  if (!version) return problem(404, "Pipeline version not found.", "not_found");

  const canDownload =
    (await canAccessStudy(authResult.userId, version.project.studyId, "downloadPipelineBundle")) ||
    (await canAccessAnyStudySite(authResult.userId, version.project.studyId, "downloadPipelineBundle"));
  if (!canDownload) return problem(403, "You do not have permission to download this pipeline bundle.", "forbidden");

  await audit({
    actorUserId: authResult.userId,
    orgId: version.project.study.orgId,
    studyId: version.project.studyId,
    action: "pipeline.version.download",
    targetType: "PipelineVersion",
    targetId: version.id,
    metadata: { gitCommit: version.gitCommit, artifactStorageKey: version.artifactStorageKey },
    request
  });

  if (!storageConfigured() || !version.artifactStorageKey) {
    return json({
      pipelineVersion: version,
      downloadUrl: null,
      message: "Pipeline bundle metadata is registered, but object storage is not available for download."
    });
  }

  const downloadUrl = await createPresignedDownloadUrl(version.artifactStorageKey, `${version.project.name}-${version.version}.zip`);
  return json({ pipelineVersion: version, downloadUrl, expiresInSeconds: 300 });
}
