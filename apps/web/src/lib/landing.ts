/** Where a signed-in person should land. Pure so it can be tested without a database. */

export type LandingSite = { studySiteId: string; name: string; studyTitle: string; roles: string[] };

export type LandingInput = {
  userId: string;
  platformRole?: string | null;
  siteCount: number;
  /** True when the person has an unaccepted, unexpired site invitation. */
  pendingSiteInvite?: boolean;
  studyMembers: Array<{ study: { defaultStudy: boolean; createdById: string; _count?: { studySites?: number; pipelineProjects?: number } } }>;
  orgMemberships: Array<{ role: string; status?: string; organization: { slug: string } }>;
};

export const SITE_LANDING = "/my-site";
export const DEFAULT_LANDING = "/dashboard";

/** True for the study every new account gets, while nothing has been added to it. */
function isUntouchedDefaultStudy(userId: string, member: LandingInput["studyMembers"][number]): boolean {
  const study = member.study;
  return study.defaultStudy && study.createdById === userId && (study._count?.studySites ?? 0) === 0 && (study._count?.pipelineProjects ?? 0) === 0;
}

/**
 * "/my-site" for a person who has site access and nothing else of their own (no study membership other than their
 * untouched auto-created default study, no admin rights in a shared organisation); otherwise the usual dashboard.
 */
export function landingFor(input: LandingInput): string {
  if (input.siteCount === 0 && !input.pendingSiteInvite) return DEFAULT_LANDING;
  if (input.platformRole === "PLATFORM_ADMIN" || input.platformRole === "AUDITOR") return DEFAULT_LANDING;
  if (input.studyMembers.some((member) => !isUntouchedDefaultStudy(input.userId, member))) return DEFAULT_LANDING;
  const adminOfSharedOrg = input.orgMemberships.some(
    (membership) => membership.role === "ORG_ADMIN" && membership.status !== "SUSPENDED" && membership.organization.slug !== `personal-${input.userId}`
  );
  return adminOfSharedOrg ? DEFAULT_LANDING : SITE_LANDING;
}
