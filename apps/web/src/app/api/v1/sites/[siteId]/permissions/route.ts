import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { canAccessStudy, canAccessSiteActions, SITE_ACTIONS } from "@/lib/rbac";

/**
 * GET /api/v1/sites/[siteId]/permissions
 * -> { can: Record<SiteAction, boolean>, backHref: string | null }
 * backHref is the study's Sites page when the person can read the study, "/my-site" when they only have site access,
 * and null when they have no access at all. Never 403: no access is all false.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  const can = await canAccessSiteActions(authResult.userId, siteId, SITE_ACTIONS);
  let backHref: string | null = null;
  if (can.read) {
    const site = await prisma.studySite.findUnique({ where: { id: siteId }, select: { studyId: true } });
    backHref = site && (await canAccessStudy(authResult.userId, site.studyId, "read")) ? `/studies/${site.studyId}?section=sites` : "/my-site";
  }
  return json({ can, backHref });
}
