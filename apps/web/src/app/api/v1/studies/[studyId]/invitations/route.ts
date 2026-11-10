import { z } from "zod";
import type { StudyRole } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { randomToken, sha256 } from "@/lib/crypto";
import { sendInvitationEmail } from "@/lib/email";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertCanGrantRoles, assertStudyAccess, isForbiddenError } from "@/lib/rbac";
import { publicBaseUrl } from "@/lib/runtime-config";

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

const siteRoleSchema = z.enum(["SITE_PI", "SITE_ADMIN", "SITE_DATA_STEWARD", "SITE_ENGINEER", "SITE_REVIEWER"]);

// A site invitation carries a site and site roles only: no study roles, so it can never grant study access.
const createSiteInvitationSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  studySiteId: z.string().min(1),
  siteRoles: z.array(siteRoleSchema).min(1).max(5).default(["SITE_ADMIN", "SITE_PI"]),
  expiresInDays: z.number().int().min(1).max(30).default(14)
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

  const rows = await prisma.invitation.findMany({
    where: { studyId },
    include: { studySite: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }
  });
  // Site invitations carry the site name and no study roles.
  // The token hash is never sent out, and the placeholder role of a site invitation is not shown as an Auditor role.
  const invitations = rows.map(({ studySite, tokenHash: _tokenHash, ...invitation }) => ({
    ...invitation,
    role: invitation.studySiteId ? null : invitation.role,
    roles: invitation.studySiteId ? [] : invitation.roles,
    siteName: studySite?.name ?? null
  }));

  return json({ invitations });
}

export async function POST(request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body === "object" && body.studySiteId !== undefined) {
    return createSiteInvitation(request, authResult.userId, studyId, body);
  }

  try {
    await assertStudyAccess(authResult.userId, studyId, "invite");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = createInvitationSchema.safeParse(body);
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid invitation.");

  try {
    await assertCanGrantRoles(authResult.userId, studyId, parsed.data.roles);
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    include: { organization: true }
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

  // Behind the ingress the request origin is the pod's own address, so build the link from the public URL.
  const inviteUrl = new URL(`/signin?invite=${token}`, publicBaseUrl(request.nextUrl.origin)).toString();

  let emailSent = false;
  try {
    emailSent = await sendInvitationEmail({
      to: parsed.data.email,
      studyTitle: study.title,
      inviterName: await inviterName(authResult.userId),
      inviteUrl
    });
  } catch (error) {
    // The invitation exists and the link is returned below; a mail outage must not lose it.
    console.error("Invitation email failed.", { to: parsed.data.email, error: error instanceof Error ? error.message : String(error) });
  }

  await audit({
    actorUserId: authResult.userId,
    orgId: study.orgId,
    studyId,
    action: "invitation.create",
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { email: parsed.data.email, roles: parsed.data.roles, emailSent },
    request
  });

  const { tokenHash: _hash, ...publicInvitation } = invitation;
  return json({ invitation: publicInvitation, inviteUrl, emailSent }, { status: 201 });
}

async function inviterName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ?? "A Fedlify study member";
}

async function createSiteInvitation(request: NextRequest, userId: string, studyId: string, body: unknown) {
  // Site roles give no study access, so there is no escalation path; managing sites is the only gate.
  try {
    await assertStudyAccess(userId, studyId, "manageSites");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const parsed = createSiteInvitationSchema.safeParse(body);
  if (!parsed.success) return problem(400, parsed.error.issues[0]?.message ?? "Invalid invitation.");
  const siteRoles = Array.from(new Set(parsed.data.siteRoles));

  const [study, site] = await Promise.all([
    prisma.study.findUnique({ where: { id: studyId } }),
    prisma.studySite.findUnique({ where: { id: parsed.data.studySiteId }, select: { id: true, studyId: true, name: true, participationStatus: true } })
  ]);
  if (!study) return problem(404, "Study not found.", "not_found");
  if (!site || site.studyId !== studyId) return problem(404, "That site does not belong to this study.", "not_found");
  if (site.participationStatus === "DISABLED") return problem(409, "This site is turned off, so it cannot be given new people.", "invalid_state");

  // One waiting invitation per person and site, and nothing for someone who already has access.
  const [waiting, existingMember] = await Promise.all([
    prisma.invitation.findFirst({ where: { studySiteId: site.id, email: parsed.data.email, status: "PENDING", expiresAt: { gt: new Date() } }, select: { id: true } }),
    prisma.siteMember.findFirst({ where: { studySiteId: site.id, user: { email: parsed.data.email } }, select: { id: true } })
  ]);
  if (waiting) return problem(409, "An invitation to this site is already waiting for that person.", "invitation_waiting");
  if (existingMember) return problem(409, "That person already has access to this site.", "already_member");

  const token = randomToken();
  const invitation = await prisma.invitation.create({
    data: {
      studyId,
      orgId: study.orgId,
      email: parsed.data.email,
      // The column is required; a site invitation never grants it (roles stays empty and accept branches on studySiteId).
      role: "AUDITOR",
      roles: [],
      studySiteId: site.id,
      siteRoles,
      tokenHash: sha256(token),
      invitedById: userId,
      expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    }
  });

  const inviteUrl = new URL(`/signin?invite=${token}`, publicBaseUrl(request.nextUrl.origin)).toString();

  let emailSent = false;
  try {
    emailSent = await sendInvitationEmail({
      to: parsed.data.email,
      studyTitle: study.title,
      siteName: site.name,
      inviterName: await inviterName(userId),
      inviteUrl
    });
  } catch (error) {
    console.error("Invitation email failed.", { to: parsed.data.email, error: error instanceof Error ? error.message : String(error) });
  }

  await audit({
    actorUserId: userId,
    orgId: study.orgId,
    studyId,
    action: "invitation.site.create",
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { email: parsed.data.email, studySiteId: site.id, siteName: site.name, siteRoles, emailSent },
    request
  });

  const { tokenHash: _hash, ...publicInvitation } = invitation;
  return json({ invitation: { ...publicInvitation, role: null, siteName: site.name }, inviteUrl, emailSent }, { status: 201 });
}
