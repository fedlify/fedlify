import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, isForbiddenError } from "@/lib/rbac";

const siteMemberSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  role: z.enum(["SITE_PI", "SITE_ADMIN", "SITE_DATA_STEWARD", "SITE_ENGINEER", "SITE_REVIEWER"])
});

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "assignMembers");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = siteMemberSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid site member.");

  const studySite = await prisma.studySite.findUnique({ where: { id: siteId }, include: { study: true } });
  if (!studySite) return problem(404, "Participant site not found.", "not_found");

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) return problem(404, "The site member must register before they can be assigned to a site.", "user_not_found");

  const member = await prisma.siteMember.upsert({
    where: { studySiteId_userId_role: { studySiteId: siteId, userId: user.id, role: parsed.data.role } },
    update: {},
    create: {
      studySiteId: siteId,
      userId: user.id,
      role: parsed.data.role,
      invitedById: authResult.userId
    },
    include: { user: { select: { id: true, name: true, email: true } } }
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.study.orgId,
    studyId: studySite.studyId,
    action: "site.member.assign",
    targetType: "SiteMember",
    targetId: member.id,
    metadata: { role: member.role, email: parsed.data.email },
    request
  });

  return json({ member }, { status: 201 });
}
