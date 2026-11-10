import type { PlatformRole, SiteRole, StudyRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type StudyAction =
  | "read"
  | "manage"
  | "activateStudy"
  | "invite"
  | "uploadDocument"
  | "manageEthics"
  | "manageSites"
  | "manageSiteProfiles"
  | "assignSiteRoles"
  | "runAgent"
  | "approvePipeline"
  | "submitJob"
  | "abortJob"
  | "approveRelease"
  | "downloadRelease"
  | "downloadPipelineBundle"
  | "viewLogs"
  | "audit";

const permissionsByRole: Record<StudyRole, StudyAction[]> = {
  PRINCIPAL_INVESTIGATOR: [
    "read",
    "manage",
    "activateStudy",
    "invite",
    "uploadDocument",
    "manageEthics",
    "manageSites",
    "manageSiteProfiles",
    "assignSiteRoles",
    "runAgent",
    "approvePipeline",
    "submitJob",
    "abortJob",
    "approveRelease",
    "downloadRelease",
    "downloadPipelineBundle",
    "viewLogs",
    "audit"
  ],
  STUDY_OWNER: [
    "read",
    "manage",
    "activateStudy",
    "invite",
    "uploadDocument",
    "manageEthics",
    "manageSites",
    "manageSiteProfiles",
    "assignSiteRoles",
    "runAgent",
    "approvePipeline",
    "submitJob",
    "abortJob",
    "approveRelease",
    "downloadRelease",
    "downloadPipelineBundle",
    "viewLogs",
    "audit"
  ],
  STUDY_COORDINATOR: [
    "read",
    "invite",
    "uploadDocument",
    "manageSites",
    "manageSiteProfiles",
    "runAgent",
    "downloadRelease",
    "downloadPipelineBundle",
    "viewLogs"
  ],
  CLINICAL_LEAD: [
    "read",
    "uploadDocument",
    "manageEthics",
    "approvePipeline",
    "downloadRelease",
    "downloadPipelineBundle",
    "viewLogs",
    "audit"
  ],
  ETHICS_REVIEWER: ["read", "uploadDocument", "manageEthics", "audit"],
  DATA_SCIENTIST: ["read", "uploadDocument", "runAgent", "downloadRelease", "downloadPipelineBundle"],
  PIPELINE_DEVELOPER: ["read", "uploadDocument", "runAgent", "downloadRelease", "downloadPipelineBundle", "viewLogs"],
  PRIVACY_SECURITY_OFFICER: ["read", "uploadDocument", "manageEthics", "approvePipeline", "downloadPipelineBundle", "viewLogs", "audit"],
  RELEASE_APPROVER: [
    "read",
    "approvePipeline",
    "submitJob",
    "abortJob",
    "approveRelease",
    "downloadRelease",
    "downloadPipelineBundle",
    "viewLogs",
    "audit"
  ],
  SITE_ADMIN: ["read", "downloadRelease", "viewLogs"],
  AUDITOR: ["read", "viewLogs", "audit"]
};

export type SiteAction =
  | "read"
  | "manageProfile"
  | "updateReadiness"
  | "assignMembers"
  | "viewLogs"
  | "downloadRelease"
  | "downloadJoinKit"
  | "downloadPipelineBundle"
  | "rotateSiteToken"
  | "acceptSitePolicy"
  | "audit";

const permissionsBySiteRole: Record<SiteRole, SiteAction[]> = {
  SITE_PI: ["read", "acceptSitePolicy", "viewLogs", "downloadPipelineBundle", "audit"],
  SITE_ADMIN: [
    "read",
    "manageProfile",
    "updateReadiness",
    "assignMembers",
    "viewLogs",
    "downloadRelease",
    "downloadJoinKit",
    "downloadPipelineBundle",
    "rotateSiteToken",
    "acceptSitePolicy"
  ],
  SITE_DATA_STEWARD: ["read", "manageProfile", "updateReadiness", "acceptSitePolicy", "audit"],
  SITE_ENGINEER: ["read", "manageProfile", "updateReadiness", "viewLogs", "downloadJoinKit", "rotateSiteToken"],
  SITE_REVIEWER: ["read", "viewLogs", "downloadPipelineBundle", "audit"]
};

export function roleCan(role: StudyRole, action: StudyAction): boolean {
  return permissionsByRole[role].includes(action);
}

export function siteRoleCan(role: SiteRole, action: SiteAction): boolean {
  return permissionsBySiteRole[role].includes(action);
}

export function platformCan(platformRole: PlatformRole, action: StudyAction): boolean {
  if (platformRole === "PLATFORM_ADMIN") return true;
  if (platformRole === "AUDITOR") return action === "read" || action === "audit" || action === "viewLogs";
  return false;
}

const ORG_ADMIN_NEEDS_STUDY_ROLE: StudyAction[] = ["approveRelease", "approvePipeline", "submitJob", "abortJob"];

/** Several study permissions for one person with a single lookup of the user and the study. */
export async function canAccessStudyActions<T extends StudyAction>(userId: string, studyId: string, actions: readonly T[]): Promise<Record<T, boolean>> {
  const result = Object.fromEntries(actions.map((action) => [action, false])) as Record<T, boolean>;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true }
  });

  if (!user) return result;
  const remaining = actions.filter((action) => {
    if (platformCan(user.platformRole, action)) {
      result[action] = true;
      return false;
    }
    return true;
  });
  if (remaining.length === 0) return result;

  const study = await prisma.study.findUnique({
    where: { id: studyId },
    select: {
      orgId: true,
      members: {
        where: { userId },
        select: { role: true }
      },
      organization: {
        select: {
          memberships: {
            where: { userId, status: "ACTIVE" },
            select: { role: true }
          }
        }
      }
    }
  });

  if (!study) return result;
  const orgAdmin = study.organization.memberships.some((membership) => membership.role === "ORG_ADMIN");
  for (const action of remaining) {
    const byRole = study.members.some((member) => roleCan(member.role, action));
    result[action] = orgAdmin && !ORG_ADMIN_NEEDS_STUDY_ROLE.includes(action) ? true : byRole;
  }
  return result;
}

export async function canAccessStudy(userId: string, studyId: string, action: StudyAction): Promise<boolean> {
  return (await canAccessStudyActions(userId, studyId, [action]))[action];
}

export type RoleGrantActor = {
  platformAdmin: boolean;
  orgAdmin: boolean;
  /** The actor's own study roles. */
  roles: StudyRole[];
};

/** Actions an org admin gets without holding a study role for them (mirrors canAccessStudy). */
const ORG_ADMIN_NEEDS_ROLE: StudyAction[] = ["approveRelease", "approvePipeline", "submitJob", "abortJob"];

function actorCan(actor: RoleGrantActor, action: StudyAction): boolean {
  if (actor.platformAdmin) return true;
  if (actor.roles.some((role) => roleCan(role, action))) return true;
  return actor.orgAdmin && !ORG_ADMIN_NEEDS_ROLE.includes(action);
}

/** Roles the actor may grant or remove: those whose every permission the actor also has. */
export function grantableRoles(actor: RoleGrantActor): StudyRole[] {
  return (Object.keys(permissionsByRole) as StudyRole[]).filter((role) => permissionsByRole[role].every((action) => actorCan(actor, action)));
}

/** The subset of `roles` the actor may not grant or remove. */
export function ungrantableRoles(actor: RoleGrantActor, roles: StudyRole[]): StudyRole[] {
  const allowed = new Set(grantableRoles(actor));
  return roles.filter((role) => !allowed.has(role));
}

const ROLE_LABELS: Record<StudyRole, string> = {
  PRINCIPAL_INVESTIGATOR: "Principal Investigator",
  STUDY_OWNER: "Study Owner",
  STUDY_COORDINATOR: "Study Coordinator",
  CLINICAL_LEAD: "Clinical Lead",
  ETHICS_REVIEWER: "Ethics Reviewer",
  DATA_SCIENTIST: "Data Scientist",
  PIPELINE_DEVELOPER: "Pipeline Developer",
  PRIVACY_SECURITY_OFFICER: "Privacy and Security Officer",
  RELEASE_APPROVER: "Release Approver",
  SITE_ADMIN: "Site Admin",
  AUDITOR: "Auditor"
};

export const STUDY_LEAD_ROLES: StudyRole[] = ["PRINCIPAL_INVESTIGATOR", "STUDY_OWNER"];

/**
 * Throws a ForbiddenError naming the roles the actor may not grant or remove. A person can only hand out access they
 * hold themselves, so a coordinator cannot make anyone (including themselves) a Principal Investigator.
 */
export async function assertCanGrantRoles(userId: string, studyId: string, roles: StudyRole[]): Promise<void> {
  const [user, study] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } }),
    prisma.study.findUnique({
      where: { id: studyId },
      select: {
        members: { where: { userId }, select: { role: true } },
        organization: { select: { memberships: { where: { userId, status: "ACTIVE" }, select: { role: true } } } }
      }
    })
  ]);
  const blocked = ungrantableRoles(
    {
      platformAdmin: user?.platformRole === "PLATFORM_ADMIN",
      orgAdmin: Boolean(study?.organization.memberships.some((membership) => membership.role === "ORG_ADMIN")),
      roles: study?.members.map((member) => member.role) ?? []
    },
    roles
  );
  if (blocked.length === 0) return;
  const error = new Error(
    `You cannot grant or remove the ${blocked.map((role) => ROLE_LABELS[role]).join(", ")} role because it gives more access than you have yourself.`
  );
  error.name = "ForbiddenError";
  throw error;
}

export async function canAccessSite(userId: string, siteId: string, action: SiteAction): Promise<boolean> {
  const site = await prisma.studySite.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      studyId: true,
      members: {
        where: { userId },
        select: { role: true }
      }
    }
  });

  if (!site) return false;

  if (await canAccessStudy(userId, site.studyId, "manageSites")) return true;
  if (action === "downloadRelease" && (await canAccessStudy(userId, site.studyId, "downloadRelease"))) return true;
  if (action === "downloadPipelineBundle" && (await canAccessStudy(userId, site.studyId, "downloadPipelineBundle"))) {
    return true;
  }
  if (action === "viewLogs" && (await canAccessStudy(userId, site.studyId, "viewLogs"))) return true;

  return site.members.some((member) => siteRoleCan(member.role, action));
}

export async function canAccessAnyStudySite(userId: string, studyId: string, action: SiteAction): Promise<boolean> {
  if (await canAccessStudy(userId, studyId, "manageSites")) return true;
  if (action === "downloadPipelineBundle" && (await canAccessStudy(userId, studyId, "downloadPipelineBundle"))) return true;
  if (action === "viewLogs" && (await canAccessStudy(userId, studyId, "viewLogs"))) return true;

  const site = await prisma.studySite.findFirst({
    where: { studyId, members: { some: { userId } } },
    select: { members: { where: { userId }, select: { role: true } } }
  });

  return Boolean(site?.members.some((member) => siteRoleCan(member.role, action)));
}

export async function assertStudyAccess(userId: string, studyId: string, action: StudyAction): Promise<void> {
  if (!(await canAccessStudy(userId, studyId, action))) {
    const error = new Error("You do not have permission to perform this action for this study.");
    error.name = "ForbiddenError";
    throw error;
  }
}

export async function assertSiteAccess(userId: string, siteId: string, action: SiteAction): Promise<void> {
  if (!(await canAccessSite(userId, siteId, action))) {
    const error = new Error("You do not have permission to perform this action for this participant site.");
    error.name = "ForbiddenError";
    throw error;
  }
}

export function isForbiddenError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ForbiddenError";
}
