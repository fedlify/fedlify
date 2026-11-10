import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertSiteAccess, assertStudyAccess, canAccessStudy, isForbiddenError } from "@/lib/rbac";

const siteMemberSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  role: z.enum(["SITE_PI", "SITE_ADMIN", "SITE_DATA_STEWARD", "SITE_ENGINEER", "SITE_REVIEWER"])
});

export async function POST(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  const studySite = await prisma.studySite.findUnique({ where: { id: siteId }, include: { study: true } });
  if (!studySite) return problem(404, "Site not found.", "not_found");

  // Adding someone directly, without their acceptance, is for the study team only. Site staff invite people by email
  // (the study invitation route), so this route cannot be used to probe which addresses have accounts.
  try {
    await assertStudyAccess(authResult.userId, studySite.studyId, "manageSites");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = siteMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "The site member details are not valid.");

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Same answer whether or not the address has an account.
  if (!user) return json({ requested: true }, { status: 202 });

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

  return json({ requested: true }, { status: 202 });
}

// Remove a person from this site: all their roles, or just one when `role` is given.
const removeMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["SITE_PI", "SITE_ADMIN", "SITE_DATA_STEWARD", "SITE_ENGINEER", "SITE_REVIEWER"]).optional()
});

export async function DELETE(request: NextRequest, context: { params: Promise<{ siteId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { siteId } = await context.params;

  try {
    await assertSiteAccess(authResult.userId, siteId, "assignMembers");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const body = await request.json().catch(() => ({}));
  const parsed = removeMemberSchema.safeParse({
    userId: (body as { userId?: unknown }).userId ?? request.nextUrl.searchParams.get("userId") ?? undefined,
    role: (body as { role?: unknown }).role ?? request.nextUrl.searchParams.get("role") ?? undefined
  });
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Say which person to remove.");

  const studySite = await prisma.studySite.findUnique({ where: { id: siteId }, include: { study: true } });
  if (!studySite) return problem(404, "Site not found.", "not_found");

  // Site staff may not leave their site without an administrator. The study team can always clean up.
  const removesAdmin = !parsed.data.role || parsed.data.role === "SITE_ADMIN";
  if (removesAdmin && !(await canAccessStudy(authResult.userId, studySite.studyId, "manageSites"))) {
    const remainingAdmins = await prisma.siteMember.count({
      where: { studySiteId: siteId, role: "SITE_ADMIN", NOT: { userId: parsed.data.userId } }
    });
    if (remainingAdmins === 0) {
      return problem(409, "This is the last site contact. Add another site contact first, or ask the study lead to make the change.", "last_site_admin");
    }
  }

  const removed = await prisma.siteMember.deleteMany({
    where: { studySiteId: siteId, userId: parsed.data.userId, ...(parsed.data.role ? { role: parsed.data.role } : {}) }
  });
  if (removed.count === 0) return problem(404, "That person is not on this site.", "not_found");

  await audit({
    actorUserId: authResult.userId,
    orgId: studySite.study.orgId,
    studyId: studySite.studyId,
    action: "site.member.remove",
    targetType: "StudySite",
    targetId: siteId,
    metadata: { userId: parsed.data.userId, role: parsed.data.role ?? "all", removed: removed.count },
    request
  });

  return json({ removed: removed.count });
}
