import { requireUser } from "@/lib/api";
import { json } from "@/lib/json";
import { landingFor } from "@/lib/landing";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/me
 * { user, sites: [{ studySiteId, name, studyTitle, roles: SiteRole[] }], landing: "/my-site" | "/dashboard" }
 */
export async function GET() {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const [user, siteMembers] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authResult.userId },
      // The password hash never leaves the server, even to its own owner.
      omit: { passwordHash: true },
      include: {
        profile: true,
        orgMemberships: {
          include: { organization: true }
        },
        studyMembers: {
          include: {
            study: {
              include: { organization: true, _count: { select: { studySites: true, pipelineProjects: true } } }
            }
          }
        }
      }
    }),
    prisma.siteMember.findMany({
      where: { userId: authResult.userId },
      select: { studySiteId: true, role: true, studySite: { select: { name: true, study: { select: { title: true } } } } },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const pendingSiteInvites = user?.email
    ? await prisma.invitation.count({
        where: { email: user.email.toLowerCase(), status: "PENDING", studySiteId: { not: null }, expiresAt: { gt: new Date() } }
      })
    : 0;

  const bySite = new Map<string, { studySiteId: string; name: string; studyTitle: string; roles: string[] }>();
  for (const member of siteMembers) {
    const entry = bySite.get(member.studySiteId) ?? {
      studySiteId: member.studySiteId,
      name: member.studySite.name,
      studyTitle: member.studySite.study.title,
      roles: []
    };
    entry.roles.push(member.role);
    bySite.set(member.studySiteId, entry);
  }
  const sites = [...bySite.values()];

  const landing = user
    ? landingFor({
        userId: user.id,
        platformRole: user.platformRole,
        siteCount: sites.length,
        pendingSiteInvite: pendingSiteInvites > 0,
        studyMembers: user.studyMembers,
        orgMemberships: user.orgMemberships
      })
    : "/dashboard";

  return json({ user, sites, landing, pendingSiteInvite: pendingSiteInvites > 0 });
}
