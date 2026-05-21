import { z } from "zod";
import type { StudyRole } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { sendInvitationEmail } from "@/lib/email";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

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

const createInvitationSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  role: studyRoleSchema.optional(),
  roles: z.array(studyRoleSchema).min(1).max(9).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(14)
}).transform((input) => {
  const roles = Array.from(new Set(input.roles?.length ? input.roles : input.role ? [input.role] : ["DATA_SCIENTIST"])) as StudyRole[];
  return { ...input, role: roles[0], roles };
});

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "invite");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const invitations = await prisma.invitation.findMany({
    where: { studyId },
    orderBy: { createdAt: "desc" }
  });

  return json({ invitations });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "invite");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = createInvitationSchema.safeParse(await request.json());
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid invitation.");

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    include: { organization: true, createdBy: true }
  });
  if (!study) return problem(404, "Study not found.", "not_found");

  const token = randomToken();
  const invitation = await prisma.invitation.create({
    data: {
      studyId,
      orgId: study.orgId,
      email: parsed.data.email,
      role: parsed.data.role,
      roles: parsed.data.roles,
      tokenHash: sha256(token),
      invitedById: authResult.userId,
      expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    }
  });

  const inviteUrl = new URL(`/signin?invite=${token}`, request.nextUrl.origin).toString();

  await sendInvitationEmail({
    to: parsed.data.email,
    studyTitle: study.title,
    inviterName: study.createdBy.name ?? "A Fedlify study member",
    inviteUrl
  });

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "invitation.create",
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { email: parsed.data.email, roles: parsed.data.roles },
    request
  });

  return json({ invitation, inviteUrl }, { status: 201 });
}
