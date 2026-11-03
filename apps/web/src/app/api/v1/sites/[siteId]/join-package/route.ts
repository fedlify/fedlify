import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { directoryToArchiveMap, unzipToArchiveMap, zipFiles, type ArchiveFileMap } from "@/lib/archive";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";
import { buildPublishedSiteKitFiles } from "@/lib/site-kit";
import { buildStartupKitFiles, buildStartupPackageManifest, startupPackageChecksum } from "@/lib/site-onboarding";
import { createPresignedDownloadUrl, objectKey, readObject, storageConfigured, uploadObject } from "@/lib/storage";
import { clientKitStorageKey, nvflareClientName } from "@/lib/study-runtime";

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
  const publishedRuntime = activeDeployment?.runtimeMode === "k8s";
  const clientName = publishedRuntime
    ? nvflareClientName({ code: studySite.code, nvflareClientName: studySite.site.nvflareClientName })
    : studySite.site.nvflareClientName;
  if (publishedRuntime) {
    const provisioned = Array.isArray(activeDeployment.provisionedSites)
      ? (activeDeployment.provisionedSites as Array<{ name?: string }>).some((site) => site.name === clientName)
      : false;
    if (activeDeployment.status !== "ACTIVE" || !activeDeployment.imageDigest || !activeDeployment.clientKitPrefix) {
      return problem(409, "The study aggregator is not published yet. Publish the study before releasing site kits.", "aggregator_not_published");
    }
    if (!provisioned) {
      return problem(409, "This site joined after the last publish. Republish the study to issue its certificate.", "site_not_provisioned");
    }
    if (!process.env.FEDLIFY_STUDY_PULL_USERNAME || !process.env.FEDLIFY_STUDY_PULL_PASSWORD) {
      return problem(503, "Study image pull credentials (FEDLIFY_STUDY_PULL_USERNAME/PASSWORD) are not configured.", "registry_not_configured");
    }
  }
  const manifest = buildStartupPackageManifest({
    apiBaseUrl: publicBaseUrl(request.nextUrl.origin),
    studyId: studySite.studyId,
    studyTitle: studySite.study.title,
    studySiteId: studySite.id,
    siteId: studySite.site.id,
    siteCode: studySite.code,
    siteName: studySite.name,
    nvflareClientName: clientName,
    deployment: activeDeployment,
    expiresAt
  });
  let startupFiles: ArchiveFileMap;
  let realNvflareFiles: ArchiveFileMap;
  let clientStartupPath: string | undefined;
  if (publishedRuntime) {
    try {
      realNvflareFiles = await unzipToArchiveMap(await readObject(clientKitStorageKey(activeDeployment.clientKitPrefix!, clientName)));
    } catch (error) {
      return problem(
        503,
        `The client startup kit for ${clientName} could not be read from storage: ${error instanceof Error ? error.message : "unknown error"}`,
        "client_kit_unavailable"
      );
    }
    startupFiles = buildPublishedSiteKitFiles({
      manifest,
      hostname: activeDeployment.hostname!,
      imageDigest: activeDeployment.imageDigest!,
      registry: {
        server: process.env.FEDLIFY_STUDY_REGISTRY ?? activeDeployment.imageDigest!.split("/")[0],
        username: process.env.FEDLIFY_STUDY_PULL_USERNAME!,
        password: process.env.FEDLIFY_STUDY_PULL_PASSWORD!
      }
    });
  } else {
    startupFiles = buildStartupKitFiles(manifest);
    const clientStartupPaths = activeDeployment?.clientStartupPaths as Record<string, string> | null | undefined;
    clientStartupPath = clientStartupPaths?.[studySite.id];
    realNvflareFiles = clientStartupPath ? await directoryToArchiveMap(clientStartupPath, "nvflare").catch(() => ({})) : {};
  }
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
        expiresAt,
        deploymentId: activeDeployment?.id,
        imageDigest: publishedRuntime ? activeDeployment.imageDigest : null
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
      runtimeMode: activeDeployment?.runtimeMode,
      imageDigest: publishedRuntime ? activeDeployment.imageDigest : undefined,
      realNvflareStartupIncluded: Object.keys(realNvflareFiles).some((path) => path.endsWith("startup/fed_client.json"))
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
