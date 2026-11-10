import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/crypto";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";

// Either the emailed token or, for the signed-in recipient acting from the dashboard, the invitation id.
// Both paths require the signed-in email to match the invitation, so the id form grants nothing extra.
const acceptSchema = z.union([z.object({ token: z.string().min(20) }), z.object({ invitationId: z.string().min(1) })]);

export async function POST(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const parsed = acceptSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return problem(400, "Invalid invitation token.");

  const invitation = await prisma.invitation.findUnique({
    where: "token" in parsed.data ? { tokenHash: sha256(parsed.data.token) } : { id: parsed.data.invitationId },
    include: { study: true }
  });

  if (!invitation) return problem(404, "Invitation not found.", "not_found");
  if (invitation.status !== "PENDING") return problem(409, "Invitation is no longer pending.", "invalid_state");
  if (invitation.expiresAt <= new Date()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
    return problem(410, "Invitation has expired.", "expired");
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { email: true } });
  if (user?.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    return problem(403, "This invitation belongs to a different email address.", "forbidden");
  }

  if (invitation.studySiteId) {
    const studySiteId = invitation.studySiteId;
    // The site must still exist in this study and still be taking part; turning a site off withdraws its invitations.
    const targetSite = await prisma.studySite.findUnique({ where: { id: studySiteId }, select: { studyId: true, participationStatus: true } });
    if (!targetSite || targetSite.studyId !== invitation.studyId || targetSite.participationStatus === "DISABLED") {
      return problem(409, "This site is no longer taking part, so the invitation cannot be accepted. Ask your study lead.", "invalid_state");
    }
    const siteRoles = invitation.siteRoles.length > 0 ? invitation.siteRoles : (["SITE_ADMIN", "SITE_PI"] as const);
    // Site only: SiteMember rows for this one site. No StudyMember and no OrgMembership, so the person sees nothing else.
    await prisma.$transaction(async (tx) => {
      for (const role of siteRoles) {
        await tx.siteMember.upsert({
          where: { studySiteId_userId_role: { studySiteId, userId: authResult.userId, role } },
          update: {},
          create: { studySiteId, userId: authResult.userId, role, invitedById: invitation.invitedById }
        });
      }
      await tx.invitation.update({ where: { id: invitation.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
    });

    await audit({
      actorUserId: authResult.userId,
      orgId: invitation.orgId,
      studyId: invitation.studyId,
      action: "invitation.site.accept",
      targetType: "Invitation",
      targetId: invitation.id,
      metadata: { studySiteId, siteRoles: [...siteRoles] },
      request
    });

    return json({ siteId: studySiteId });
  }

  const roles = invitation.roles.length > 0 ? invitation.roles : [invitation.role];

  await prisma.$transaction(async (tx) => {
    await tx.orgMembership.upsert({
      where: { orgId_userId: { orgId: invitation.orgId, userId: authResult.userId } },
      update: { status: "ACTIVE" },
      create: {
        orgId: invitation.orgId,
        userId: authResult.userId,
        role: "MEMBER",
        addedById: invitation.invitedById
      }
    });

    await tx.studyMember.createMany({
      data: roles.map((role) => ({ studyId: invitation.studyId, userId: authResult.userId, role })),
      skipDuplicates: true
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() }
    });
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: invitation.orgId,
    studyId: invitation.studyId,
    action: "invitation.accept",
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { roles },
    request
  });

  return json({ studyId: invitation.studyId });
}
