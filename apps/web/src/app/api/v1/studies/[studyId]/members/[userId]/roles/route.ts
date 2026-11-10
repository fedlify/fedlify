import { z } from "zod";
import type { StudyRole } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertCanGrantRoles, assertStudyAccess, isForbiddenError, STUDY_LEAD_ROLES } from "@/lib/rbac";

const studyRoleSchema = z.enum([
  "PRINCIPAL_INVESTIGATOR",
  "STUDY_COORDINATOR",
  "CLINICAL_LEAD",
  "ETHICS_REVIEWER",
  "DATA_SCIENTIST",
  "PIPELINE_DEVELOPER",
  "PRIVACY_SECURITY_OFFICER",
  "RELEASE_APPROVER",
  "AUDITOR"
]);

const updateMemberRolesSchema = z.object({
  roles: z.array(studyRoleSchema).min(1).max(9)
});

class LastLeadError extends Error {}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ studyId: string; userId: string }> }
) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId, userId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "invite");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = updateMemberRolesSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid role update.");

  const study = await prisma.study.findUnique({ where: { id: studyId }, select: { id: true, orgId: true } });
  if (!study) return problem(404, "Study not found.", "not_found");

  const existing = await prisma.studyMember.findMany({
    where: { studyId, userId },
    select: { role: true }
  });
  if (existing.length === 0) return problem(404, "Study member not found.", "not_found");

  const roles: StudyRole[] = Array.from(new Set(parsed.data.roles));
  const oldRoles = existing.map((member) => member.role);

  const changed: StudyRole[] = [
    ...roles.filter((role) => !oldRoles.includes(role)),
    ...oldRoles.filter((role) => !roles.includes(role))
  ];
  try {
    await assertCanGrantRoles(authResult.userId, studyId, changed);
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const losesLead = oldRoles.some((role) => STUDY_LEAD_ROLES.includes(role)) && !roles.some((role) => STUDY_LEAD_ROLES.includes(role));

  try {
    // Serializable, so two people demoting the last two leads at once cannot both pass the check.
    await prisma.$transaction(
      async (tx) => {
        if (losesLead) {
          const otherLeads = await tx.studyMember.count({ where: { studyId, userId: { not: userId }, role: { in: STUDY_LEAD_ROLES } } });
          if (otherLeads === 0) throw new LastLeadError();
        }

        await tx.studyMember.deleteMany({
          where: {
            studyId,
            userId,
            role: { notIn: roles }
          }
        });

        await tx.studyMember.createMany({
          data: roles.map((role) => ({ studyId, userId, role, invitedById: authResult.userId })),
          skipDuplicates: true
        });
      },
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    if (error instanceof LastLeadError) return problem(409, "A study must keep at least one study lead.", "last_study_lead");
    throw error;
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "studyMember.roles.update",
    targetType: "User",
    targetId: userId,
    metadata: { oldRoles, roles },
    request
  });

  const members = await prisma.studyMember.findMany({
    where: { studyId, userId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" }
  });

  return json({ member: { userId, roles, memberships: members } });
}
