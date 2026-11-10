import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

/** Withdraw a pending invitation. Site invitations need the manage-sites permission, study invitations the invite permission. */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ studyId: string; invitationId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, invitationId } = await context.params;

  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
  // The invitation must belong to the study in the URL, so one study's permission cannot reach another study's invitations.
  if (!invitation || invitation.studyId !== studyId) return problem(404, "Invitation not found.", "not_found");

  try {
    await assertStudyAccess(authResult.userId, studyId, invitation.studySiteId ? "manageSites" : "invite");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  if (invitation.status !== "PENDING") return problem(409, "This invitation is no longer waiting.", "invalid_state");

  await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "REVOKED" } });
  await audit({
    actorUserId: authResult.userId,
    orgId: invitation.orgId,
    studyId,
    action: "invitation.revoke",
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { email: invitation.email, studySiteId: invitation.studySiteId },
    request: _request
  });

  return json({ revoked: true });
}
