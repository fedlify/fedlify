import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { directoryToArchiveMap, zipFiles } from "@/lib/archive";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";
import { buildStartupKitFiles, buildStartupPackageManifest, startupPackageChecksum } from "@/lib/site-onboarding";
import { createPresignedDownloadUrl, objectKey, storageConfigured, uploadObject } from "@/lib/storage";

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "downloadJoinKit");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const studySite = await prisma.studySite.findUnique({
    where: { id: siteId },
    include: { study: true, site: true }
  });
  if (!studySite) return problem(404, "Participant site not found.", "not_found");
  if (!studySite.site) return problem(409, "This participant site does not have a runtime site record.", "site_not_ready");

  const enrollmentToken = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const filename = `${studySite.code}-startup-kit.zip`;
  const storageKey = objectKey(["studies", studySite.studyId, "sites", studySite.id, "join", `${Date.now()}-${filename}`]);
  const activeDeployment = await prisma.nvflareDeployment.findFirst({
    where: { studyId: studySite.studyId, active: true },
    orderBy: { updatedAt: "desc" }
  });
  const manifest = buildStartupPackageManifest({
    apiBaseUrl: publicBaseUrl(request.nextUrl.origin),
    studyId: studySite.studyId,
    studyTitle: studySite.study.title,
    studySiteId: studySite.id,
    siteId: studySite.site.id,
    siteCode: studySite.code,
    siteName: studySite.name,
    nvflareClientName: studySite.site.nvflareClientName,
    deployment: activeDeployment,
    expiresAt
  });
  const startupFiles = buildStartupKitFiles(manifest);
  const clientStartupPaths = activeDeployment?.clientStartupPaths as Record<string, string> | null | undefined;
  const clientStartupPath = clientStartupPaths?.[studySite.id];
  const realNvflareFiles = clientStartupPath ? await directoryToArchiveMap(clientStartupPath, "nvflare").catch(() => ({})) : {};
  const manifestBody = await zipFiles({ ...startupFiles, ...realNvflareFiles });
  const checksum = startupPackageChecksum(manifest);
  let sizeBytes = BigInt(0);
  const isStorageConfigured = storageConfigured();
  let storageUploaded = false;
  let storageError: string | undefined;

  if (isStorageConfigured) {
    try {
      await uploadObject(storageKey, manifestBody, "application/zip");
      sizeBytes = BigInt(manifestBody.byteLength);
      storageUploaded = true;
    } catch (error) {
      storageError = error instanceof Error ? error.message : "Object storage upload failed.";
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.siteJoinPackage.updateMany({
      where: { studySiteId: studySite.id, status: "ACTIVE" },
      data: { status: "REVOKED" }
    });

    await tx.site.update({
      where: { id: studySite.site!.id },
      data: {
        apiTokenHash: sha256(enrollmentToken),
        status: "KIT_RELEASED"
      }
    });

    await tx.studySite.update({
      where: { id: studySite.id },
      data: { participationStatus: "KIT_RELEASED" }
    });

    const siteJoinPackage = await tx.siteJoinPackage.create({
      data: {
        studySiteId: studySite.id,
        generatedById: authResult.userId,
        kind: "STARTUP_KIT",
        filename,
        contentType: "application/zip",
        storageKey,
        checksum,
        sizeBytes,
        expiresAt
      }
    });

    return siteJoinPackage;
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.organizationId,
    studyId: studySite.studyId,
    action: "site.join_package.create",
    targetType: "SiteJoinPackage",
    targetId: result.id,
    metadata: {
      studySiteId: studySite.id,
      siteId: studySite.site.id,
      checksum,
      storageConfigured: isStorageConfigured,
      storageUploaded,
      storageError,
      deploymentId: activeDeployment?.id,
      serverAddress: activeDeployment?.serverAddress,
      realNvflareStartupIncluded: Boolean(clientStartupPath && Object.keys(realNvflareFiles).length > 0)
    },
    request
  });
  const downloadUrl = storageUploaded ? await createPresignedDownloadUrl(storageKey, filename) : null;

  return json(
    {
      package: result,
      enrollmentToken,
      manifest,
      downloadUrl,
      storage: {
        configured: isStorageConfigured,
        uploaded: storageUploaded,
        error: storageError
      },
      message: storageUploaded
        ? "Startup package created. Copy the enrollment token now; it will not be shown again."
        : isStorageConfigured
          ? "Startup package metadata created locally. Object storage upload failed, so downloads are disabled until storage is available."
          : "Startup package metadata created locally. Configure object storage to enable package downloads."
    },
    { status: 201 }
  );
}
