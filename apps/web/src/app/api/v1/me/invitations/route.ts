/**
 * GET /api/v1/me/invitations
 *
 * Pending, unexpired study invitations addressed to the signed-in user's email, so a collaborator sees
 * them on the dashboard and can accept without an email link.
 */

import { requireUser } from "@/lib/api";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const user = await prisma.user.findUnique({ where: { id: authResult.userId }, select: { email: true } });
  if (!user?.email) return json({ invitations: [] });

  const invitations = await prisma.invitation.findMany({
    where: { email: user.email.toLowerCase(), status: "PENDING", expiresAt: { gt: new Date() } },
    include: { study: { select: { id: true, title: true, slug: true, organization: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" }
  });
  const inviterIds = [...new Set(invitations.map((invitation) => invitation.invitedById))];
  const inviters = inviterIds.length
    ? await prisma.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true, email: true } })
    : [];
  const inviterById = new Map(inviters.map((inviter) => [inviter.id, inviter]));

  return json({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      studyId: invitation.studyId,
      studyTitle: invitation.study.title,
      organizationName: invitation.study.organization.name,
      roles: invitation.roles.length > 0 ? invitation.roles : [invitation.role],
      invitedBy: inviterById.get(invitation.invitedById)?.name ?? inviterById.get(invitation.invitedById)?.email ?? null,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt
    }))
  });
}
