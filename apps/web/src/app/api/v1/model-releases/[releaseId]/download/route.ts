import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { canAccessStudy } from "@/lib/rbac";
import { createPresignedDownloadUrl, storageConfigured } from "@/lib/storage";

export async function GET(request: NextRequest, context: { params: Promise<{ releaseId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { releaseId } = await context.params;
  const artifactId = request.nextUrl.searchParams.get("artifactId");

  const modelRelease = await prisma.modelRelease.findUnique({
    where: { id: releaseId },
    include: { artifacts: true, study: true }
  });
  if (!modelRelease) return problem(404, "Model release not found.", "not_found");
  if (modelRelease.status !== "APPROVED") return problem(409, "Only approved model releases can be downloaded.", "not_approved");

  const artifact = artifactId ? modelRelease.artifacts.find((item) => item.id === artifactId) : modelRelease.artifacts[0];
  if (!artifact) return problem(404, "Model release artifact not found.", "not_found");

  const authorized = await canAccessStudy(authResult.userId, modelRelease.studyId, "downloadRelease");
  if (!authorized) return problem(403, "You do not have permission to download this model release artifact.", "forbidden");

  await prisma.modelArtifact.update({
    where: { id: artifact.id },
    data: { downloadCount: { increment: 1 } }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: modelRelease.study.orgId,
    studyId: modelRelease.studyId,
    action: "model_release.download",
    targetType: "ModelArtifact",
    targetId: artifact.id,
    metadata: { releaseId, version: modelRelease.version, artifactKind: artifact.kind },
    request
  });

  if (!storageConfigured()) {
    return json({
      artifact,
      downloadUrl: null,
      message: "Object storage is not configured in this local environment."
    });
  }

  const downloadUrl = await createPresignedDownloadUrl(artifact.storageKey, artifact.filename);
  return json({ artifact, downloadUrl, expiresInSeconds: 300 });
}

