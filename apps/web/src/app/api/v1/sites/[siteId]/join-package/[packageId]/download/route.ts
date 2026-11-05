import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { DOWNLOAD_GRANT_TTL_MS, mintDownloadGrant, PRESIGNED_URL_SECONDS, publicPackage, redeemDownloadGrant } from "@/lib/kit-download";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";
import { buildStartupPackageManifest } from "@/lib/site-onboarding";
import { createPresignedDownloadUrl, storageConfigured } from "@/lib/storage";
import { verifyStepUp } from "@/lib/step-up";

// Two steps, so that one password entry yields exactly one presigned URL:
//   POST {password}  -> step-up; returns a short-lived one-time grant token bound to the signed-in user
//   POST {grant}     -> redeems the grant once and returns the 5-minute presigned URL
// The grant travels in the request body, never in a URL, so it stays out of access logs and browser history.

type RouteContext = { params: Promise<{ siteId: string; packageId: string }> };

async function loadPackage(userId: string, siteId: string, packageId: string) {
  try {
    await assertSiteAccess(userId, siteId, "downloadJoinKit");
  } catch (error) {
    if (isForbiddenError(error)) return { response: problem(403, error.message, "forbidden") as Response };
    throw error;
  }
  const siteJoinPackage = await prisma.siteJoinPackage.findFirst({
    where: { id: packageId, studySiteId: siteId },
    include: { studySite: { include: { study: true, site: true } } }
  });
  if (!siteJoinPackage) return { response: problem(404, "Startup package not found.", "not_found") as Response };
  if (siteJoinPackage.status !== "ACTIVE") return { response: problem(409, "This startup package is no longer active.", "package_inactive") as Response };
  if (siteJoinPackage.expiresAt < new Date()) return { response: problem(410, "This startup package has expired.", "package_expired") as Response };
  if (!siteJoinPackage.studySite.site) return { response: problem(409, "This participant site does not have a runtime site record.", "site_not_ready") as Response };
  return { siteJoinPackage };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId, packageId } = await context.params;

  const loaded = await loadPackage(authResult.userId, siteId, packageId);
  if ("response" in loaded) return loaded.response;
  const { siteJoinPackage } = loaded;

  const body = (await request.json().catch(() => null)) as { password?: unknown; grant?: unknown } | null;
  if (body && "grant" in body) return redeem(request, authResult.userId, siteId, siteJoinPackage, body.grant);
  const stepUp = await verifyStepUp({
    userId: authResult.userId,
    password: body?.password,
    action: "site.join_package.download",
    orgId: siteJoinPackage.studySite.organizationId,
    studyId: siteJoinPackage.studySite.studyId,
    targetType: "SiteJoinPackage",
    targetId: siteJoinPackage.id,
    request
  });
  if (!stepUp.ok) return stepUp.response;

  if (!storageConfigured() || siteJoinPackage.sizeBytes === BigInt(0)) {
    const activeDeployment = await prisma.nvflareDeployment.findFirst({
      where: { studyId: siteJoinPackage.studySite.studyId, active: true },
      orderBy: { updatedAt: "desc" }
    });
    const manifest = buildStartupPackageManifest({
      apiBaseUrl: publicBaseUrl(request.nextUrl.origin),
      studyId: siteJoinPackage.studySite.studyId,
      studyTitle: siteJoinPackage.studySite.study.title,
      studySiteId: siteJoinPackage.studySite.id,
      siteId: siteJoinPackage.studySite.site!.id,
      siteCode: siteJoinPackage.studySite.code,
      siteName: siteJoinPackage.studySite.name,
      nvflareClientName: siteJoinPackage.studySite.site!.nvflareClientName,
      deployment: activeDeployment,
      expiresAt: siteJoinPackage.expiresAt
    });
    return json({
      package: publicPackage(siteJoinPackage),
      downloadUrl: null,
      grant: null,
      manifest,
      message: "Object storage is not available for this local environment, so the startup package manifest is shown inline."
    });
  }

  const grant = await mintDownloadGrant(siteJoinPackage.id, authResult.userId);
  await audit({
    actorUserId: authResult.userId,
    orgId: siteJoinPackage.studySite.organizationId,
    studyId: siteJoinPackage.studySite.studyId,
    action: "site.join_package.download_authorized",
    targetType: "SiteJoinPackage",
    targetId: siteJoinPackage.id,
    metadata: { studySiteId: siteId, checksum: siteJoinPackage.checksum, stepUp: "password", grantExpiresAt: grant.expiresAt.toISOString() },
    request
  });
  const response = json({ grant: grant.token, grantExpiresInSeconds: DOWNLOAD_GRANT_TTL_MS / 1000 });
  response.headers.set("cache-control", "no-store");
  return response;
}

async function redeem(
  request: NextRequest,
  userId: string,
  siteId: string,
  siteJoinPackage: Exclude<Awaited<ReturnType<typeof loadPackage>>, { response: Response }>["siteJoinPackage"],
  grant: unknown
) {
  const base = {
    actorUserId: userId,
    orgId: siteJoinPackage.studySite.organizationId,
    studyId: siteJoinPackage.studySite.studyId,
    targetType: "SiteJoinPackage",
    targetId: siteJoinPackage.id,
    request
  };
  // Sign first (a local computation), redeem second: a signing failure must not burn the one-time grant.
  let downloadUrl: string;
  try {
    downloadUrl = await createPresignedDownloadUrl(siteJoinPackage.storageKey, siteJoinPackage.filename);
  } catch {
    return problem(502, "Could not prepare the download link. Your confirmation is still valid; try again.", "storage_unavailable");
  }
  if (typeof grant !== "string" || !grant || !(await redeemDownloadGrant(siteJoinPackage.id, userId, grant))) {
    await audit({ ...base, action: "site.join_package.download_failed", metadata: { studySiteId: siteId, reason: grant ? "grant_invalid_or_used" : "grant_missing" } });
    return problem(403, "Confirm your password to download this kit. Each confirmation allows one download.", "step_up_required");
  }
  await audit({ ...base, action: "site.join_package.download", metadata: { studySiteId: siteId, checksum: siteJoinPackage.checksum } });
  const response = json({ package: publicPackage(siteJoinPackage), downloadUrl, expiresInSeconds: PRESIGNED_URL_SECONDS });
  response.headers.set("cache-control", "no-store");
  return response;
}
