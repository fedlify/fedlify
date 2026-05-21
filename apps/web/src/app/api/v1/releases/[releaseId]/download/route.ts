import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createPresignedDownloadUrl, storageConfigured } from "@/lib/storage";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { canAccessAnyStudySite, canAccessSite, canAccessStudy } from "@/lib/rbac";

export async function GET(request: NextRequest, context: { params: Promise<{ releaseId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { releaseId } = await context.params;
  const artifactId = request.nextUrl.searchParams.get("artifactId");

  const release = await prisma.kitRelease.findUnique({
    where: { id: releaseId },
    include: { artifacts: true, study: true }
  });
  if (!release) return problem(404, "Release not found.", "not_found");
  if (release.status !== "APPROVED") return problem(409, "Only approved releases can be downloaded.", "not_approved");

  const artifact = artifactId ? release.artifacts.find((item) => item.id === artifactId) : release.artifacts[0];
  if (!artifact) return problem(404, "Release artifact not found.", "not_found");

  let authorized = await canAccessStudy(authResult.userId, release.studyId, "downloadRelease");
  let siteScoped = false;

  if (!authorized && artifact.kind === "SITE_KIT" && artifact.siteId) {
    const studySite = await prisma.studySite.findFirst({
      where: { studyId: release.studyId, siteId: artifact.siteId },
      select: { id: true }
    });
    authorized = studySite ? await canAccessSite(authResult.userId, studySite.id, "downloadJoinKit") : false;
    siteScoped = authorized;
  }

  if (!authorized && ["SOURCE_BUNDLE", "CHECKSUM_MANIFEST", "SIGNATURE"].includes(artifact.kind)) {
    authorized = await canAccessAnyStudySite(authResult.userId, release.studyId, "downloadPipelineBundle");
    siteScoped = authorized;
  }

  if (!authorized) return problem(403, "You do not have permission to download this release artifact.", "forbidden");

  await prisma.kitArtifact.update({
    where: { id: artifact.id },
    data: { downloadCount: { increment: 1 } }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: release.study.orgId,
    studyId: release.studyId,
    action: "release.download",
    targetType: "KitArtifact",
    targetId: artifact.id,
    metadata: { releaseId, version: release.version, artifactKind: artifact.kind, siteScoped },
    request
  });

  if (!storageConfigured() || artifact.sizeBytes === BigInt(0)) {
    return json({
      artifact,
      downloadUrl: null,
      message: "Object storage artifact is registered but no downloadable object exists in this local environment."
    });
  }

  const downloadUrl = await createPresignedDownloadUrl(artifact.storageKey, artifact.filename);
  return json({ artifact, downloadUrl, expiresInSeconds: 300 });
}
