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
