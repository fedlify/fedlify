import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "rotateSiteToken");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const studySite = await prisma.studySite.findUnique({
    where: { id: siteId },
    include: { site: true }
  });
  if (!studySite) return problem(404, "Participant site not found.", "not_found");
  if (!studySite.site) return problem(409, "This participant site does not have a runtime site record.", "site_not_ready");

  const enrollmentToken = randomToken();
  await prisma.site.update({
    where: { id: studySite.site.id },
    data: { apiTokenHash: sha256(enrollmentToken) }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.organizationId,
    studyId: studySite.studyId,
    action: "site.token.rotate",
    targetType: "StudySite",
    targetId: siteId,
    metadata: { siteId: studySite.site.id },
    request
  });

  return json({
    enrollmentToken,
    message: "Site token rotated. Copy this token now; it will not be shown again."
  });
}
