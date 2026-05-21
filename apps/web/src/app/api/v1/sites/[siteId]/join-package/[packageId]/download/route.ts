import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";
import { buildStartupPackageManifest } from "@/lib/site-onboarding";
import { createPresignedDownloadUrl, storageConfigured } from "@/lib/storage";

export async function GET(_request: NextRequest, context: { params: Promise<{ siteId: string; packageId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId, packageId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "downloadJoinKit");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const siteJoinPackage = await prisma.siteJoinPackage.findFirst({
    where: { id: packageId, studySiteId: siteId },
    include: { studySite: { include: { study: true, site: true } } }
  });
  if (!siteJoinPackage) return problem(404, "Startup package not found.", "not_found");
  if (siteJoinPackage.status !== "ACTIVE") return problem(409, "This startup package is no longer active.", "package_inactive");
  if (siteJoinPackage.expiresAt < new Date()) return problem(410, "This startup package has expired.", "package_expired");
  if (!siteJoinPackage.studySite.site) return problem(409, "This participant site does not have a runtime site record.", "site_not_ready");
  const activeDeployment = await prisma.nvflareDeployment.findFirst({
    where: { studyId: siteJoinPackage.studySite.studyId, active: true },
    orderBy: { updatedAt: "desc" }
  });

  await prisma.siteJoinPackage.update({
    where: { id: siteJoinPackage.id },
    data: { downloadCount: { increment: 1 } }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: siteJoinPackage.studySite.organizationId,
    studyId: siteJoinPackage.studySite.studyId,
    action: "site.join_package.download",
    targetType: "SiteJoinPackage",
    targetId: siteJoinPackage.id,
    metadata: { studySiteId: siteId, checksum: siteJoinPackage.checksum },
    request: _request
  });

  if (!storageConfigured() || siteJoinPackage.sizeBytes === BigInt(0)) {
    const manifest = buildStartupPackageManifest({
      apiBaseUrl: publicBaseUrl(_request.nextUrl.origin),
      studyId: siteJoinPackage.studySite.studyId,
      studyTitle: siteJoinPackage.studySite.study.title,
      studySiteId: siteJoinPackage.studySite.id,
      siteId: siteJoinPackage.studySite.site.id,
      siteCode: siteJoinPackage.studySite.code,
      siteName: siteJoinPackage.studySite.name,
      nvflareClientName: siteJoinPackage.studySite.site.nvflareClientName,
      deployment: activeDeployment,
      expiresAt: siteJoinPackage.expiresAt
    });

    return json({
      package: siteJoinPackage,
      downloadUrl: null,
      manifest,
      message: "Object storage is not available for this local environment, so the startup package manifest is shown inline."
    });
  }

  const downloadUrl = await createPresignedDownloadUrl(siteJoinPackage.storageKey, siteJoinPackage.filename);
  return json({ package: siteJoinPackage, downloadUrl, expiresInSeconds: 300 });
}
