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

export async function canAccessStudy(userId: string, studyId: string, action: StudyAction): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true }
  });

  if (!user) return false;
  if (platformCan(user.platformRole, action)) return true;

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

  if (!study) return false;

  if (study.organization.memberships.some((membership) => membership.role === "ORG_ADMIN")) {
    return ["approveRelease", "approvePipeline", "submitJob", "abortJob"].includes(action)
      ? study.members.some((member) => roleCan(member.role, action))
      : true;
  }

  return study.members.some((member) => roleCan(member.role, action));
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
