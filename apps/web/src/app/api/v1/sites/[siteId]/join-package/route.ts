import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { directoryToArchiveMap, unzipToArchiveMap, zipFiles, type ArchiveFileMap } from "@/lib/archive";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { KIT_VALID_MS, publicPackage } from "@/lib/kit-download";
import { encryptKit, generateKitPassphrase } from "@/lib/kit-crypto";
import { json, problem } from "@/lib/json";
import { acquireSlot } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";
import { buildOuterKitFiles, buildPublishedSiteKitFiles, publishedKitManifest } from "@/lib/site-kit";
import { buildStartupKitFiles, buildStartupPackageManifest, startupPackageChecksum } from "@/lib/site-onboarding";
import { createPresignedDownloadUrl, deleteObject, objectKey, readObject, storageConfigured, uploadObject } from "@/lib/storage";
import { verifyStepUp } from "@/lib/step-up";
import { clientKitStorageKey, nvflareClientName } from "@/lib/study-runtime";

const MAX_CONCURRENT_ENCRYPTIONS = 2;

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

  // Step-up before anything is built or rotated: creating a kit rotates the site token and mints a client key bundle.
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const stepUp = await verifyStepUp({
    userId: authResult.userId,
    password: body?.password,
    action: "site.join_package.create",
    orgId: studySite.organizationId,
    studyId: studySite.studyId,
    targetType: "StudySite",
    targetId: studySite.id,
    request
  });
  if (!stepUp.ok) return stepUp.response;

  const enrollmentToken = randomToken();
  const expiresAt = new Date(Date.now() + KIT_VALID_MS);
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
  const baseManifest = buildStartupPackageManifest({
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
  const manifest = publishedRuntime ? publishedKitManifest(baseManifest) : baseManifest;
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
  const isStorageConfigured = storageConfigured();
  // The passphrase lives in this function only: it goes into the response and nowhere else (not the database, not the
  // audit log, not storage, not a log line). Without object storage no file is produced, so there is nothing to protect.
  const passphrase = isStorageConfigured ? generateKitPassphrase() : null;
  let manifestBody: Buffer = Buffer.alloc(0);
  if (passphrase) {
    // scrypt (work factor 18) is synchronous pure JS: about a second of CPU and 256 MB per call. Cap concurrent encryptions
    // per process so a burst of creates cannot starve the event loop or exhaust memory.
    const release = acquireSlot("kit-encrypt", MAX_CONCURRENT_ENCRYPTIONS);
    if (!release) {
      return problem(503, "Other startup kits are being encrypted right now. Wait a few seconds and try again; nothing was changed.", "kit_encryption_busy");
    }
    let encryptedKit: Buffer;
    try {
      const innerKit = await zipFiles({ ...startupFiles, ...realNvflareFiles });
      encryptedKit = await encryptKit(innerKit, passphrase);
    } finally {
      release();
    }
    manifestBody = await zipFiles(buildOuterKitFiles({ siteName: studySite.name, studyTitle: studySite.study.title, encryptedKit }));
  }
  const checksum = startupPackageChecksum(manifest);
  let sizeBytes = BigInt(0);
  let storageUploaded = false;

  // Upload first and commit only afterwards: if storage fails, the previous kit and site token stay valid.
  if (isStorageConfigured) {
    try {
      await uploadObject(storageKey, manifestBody, "application/zip");
      sizeBytes = BigInt(manifestBody.byteLength);
      storageUploaded = true;
    } catch (error) {
      await audit({
        actorUserId: authResult.userId,
        orgId: studySite.organizationId,
        studyId: studySite.studyId,
        action: "site.join_package.create_failed",
        targetType: "StudySite",
        targetId: studySite.id,
        metadata: { reason: "storage_upload_failed", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
        request
      });
      return problem(
        502,
        "The startup kit could not be saved to object storage. Nothing was changed: the previous kit and site token remain valid. Try again.",
        "storage_unavailable"
      );
    }
  }

  // Kits this one supersedes: their objects are deleted after the commit (best effort; a lifecycle rule is the backstop).
  const superseded = storageUploaded
    ? await prisma.siteJoinPackage.findMany({ where: { studySiteId: studySite.id, status: "ACTIVE" }, select: { storageKey: true } })
    : [];

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
        // The create response hands out one presigned URL right after the password check, so that counts as a download.
        downloadCount: storageUploaded ? 1 : 0,
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
      stepUp: "password",
      encryption: storageUploaded ? "age-scrypt" : "none",
      deploymentId: activeDeployment?.id,
      serverAddress: activeDeployment?.serverAddress,
      runtimeMode: activeDeployment?.runtimeMode,
      imageDigest: publishedRuntime ? activeDeployment.imageDigest : undefined,
      realNvflareStartupIncluded: Object.keys(realNvflareFiles).some((path) => path.endsWith("startup/fed_client.json"))
    },
    request
  });
  for (const old of superseded) {
    if (old.storageKey === storageKey) continue;
    try {
      await deleteObject(old.storageKey);
    } catch {
      // Best effort: the S3 lifecycle rule in the design doc is the backstop.
    }
  }
  const downloadUrl = storageUploaded ? await createPresignedDownloadUrl(storageKey, filename) : null;

  const response = json(
    {
      package: publicPackage(result),
      enrollmentToken,
      // Shown once. Fedlify keeps no copy, so a lost passphrase means creating a new kit.
      passphrase: storageUploaded ? passphrase : null,
      revocation: "partial",
      kitKind: publishedRuntime ? "published" : "local",
      manifest,
      downloadUrl,
      storage: {
        configured: isStorageConfigured,
        uploaded: storageUploaded
      },
      message: storageUploaded
        ? `Startup package created. Copy the enrollment token and the passphrase now; they will not be shown again.${
            publishedRuntime
              ? ""
              : " This is a local-runtime kit: it is encrypted like any other, but its older runner still writes the site token to .env when started. Publish the study to get the token-free runner."
          }`
        : "Startup package metadata created locally. Configure object storage to enable package downloads."
    },
    { status: 201 }
  );
  response.headers.set("cache-control", "no-store");
  return response;
}
