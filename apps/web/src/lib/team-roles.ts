/**
 * Pure helpers for the Team screen: grouping people, naming roles in plain words and building invitation requests.
 * Client-safe (no server imports); the server stays the final word on who may grant what.
 */
import type { SiteRole, StudyRole } from "@prisma/client";
import { describeStudyRoles, isSiteContact, plainRole, toSiteRoles, toStudyRoles, type PlainRoleKey } from "@/lib/plain-roles";

export const CANNOT_GRANT_MESSAGE = "You cannot give a role with more access than your own";

type PersonLike = { id?: string; name?: string | null; email?: string | null } | null | undefined;

export type TeamMember = { userId: string; name: string; email: string; roles: StudyRole[] };

export type SiteContactRow = { key: string; userId: string; name: string; email: string; studySiteId: string; siteName: string; siteRoles: SiteRole[] };

function personName(user: PersonLike): string {
  return user?.name?.trim() || user?.email || "Unknown person";
}

/** One row per person with all of their study roles, sorted by name. */
export function groupMembers(members: Array<{ userId?: string; role: StudyRole; user?: PersonLike }>): TeamMember[] {
  const byPerson = new Map<string, TeamMember>();
  for (const member of members) {
    const userId = member.user?.id ?? member.userId ?? member.user?.email ?? "";
    if (!userId) continue;
    const existing = byPerson.get(userId) ?? { userId, name: personName(member.user), email: member.user?.email ?? "", roles: [] };
    if (!existing.roles.includes(member.role)) existing.roles.push(member.role);
    byPerson.set(userId, existing);
  }
  return Array.from(byPerson.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** People who work at one site only (no study membership), one row per person and site. */
export function siteContactRows(
  studySites: Array<{ id: string; name: string; members?: Array<{ userId?: string; role: SiteRole; user?: PersonLike }> }>
): SiteContactRow[] {
  const rows = new Map<string, SiteContactRow>();
  for (const site of studySites) {
    for (const member of site.members ?? []) {
      const userId = member.user?.id ?? member.userId ?? "";
      if (!userId) continue;
      const key = `${site.id}:${userId}`;
      const row = rows.get(key) ?? { key, userId, name: personName(member.user), email: member.user?.email ?? "", studySiteId: site.id, siteName: site.name, siteRoles: [] };
      if (!row.siteRoles.includes(member.role)) row.siteRoles.push(member.role);
      rows.set(key, row);
    }
  }
  return Array.from(rows.values()).sort((a, b) => a.siteName.localeCompare(b.siteName) || a.name.localeCompare(b.name));
}

/** Plain label for a person's role at a site ("Site contact") or the detailed labels when they hold something else. */
export function siteRolesLabel(siteRoles: readonly SiteRole[]): string {
  if (isSiteContact(siteRoles)) return plainRole("SITE_CONTACT").label;
  return "Site access";
}

export type InvitationSummary = { kind: "site" | "study"; label: string; detail: string | null };

/** What a pending invitation is for: "Site contact for Hospital A" or the plain study role. */
export function invitationSummary(invitation: {
  studySiteId?: string | null;
  siteName?: string | null;
  siteRoles?: SiteRole[] | null;
  roles?: StudyRole[] | null;
  role?: StudyRole | null;
}): InvitationSummary {
  if (invitation.studySiteId) {
    const where = invitation.siteName ? ` for ${invitation.siteName}` : "";
    return { kind: "site", label: `${siteRolesLabel(invitation.siteRoles ?? [])}${where}`, detail: null };
  }
  const roles = invitation.roles && invitation.roles.length > 0 ? invitation.roles : invitation.role ? [invitation.role] : [];
  const described = describeStudyRoles(roles);
  return { kind: "study", label: described.label, detail: described.detail };
}

/** A role that needs every permission can only be given by someone who has every permission. */
export function canGrantFullAccess(can: Partial<Record<string, boolean>>): boolean {
  const values = Object.values(can);
  return values.length > 0 && values.every(Boolean);
}

export type InviteChoice = PlainRoleKey | "ADVANCED";

/** Why a role card is switched off, or null when the person may pick it. The server still decides. */
export function roleDisabledReason(
  choice: PlainRoleKey | StudyRole,
  can: Partial<Record<string, boolean>>,
  options: { siteCount: number }
): string | null {
  if (choice === "SITE_CONTACT") {
    if (!can.manageSites) return "You do not have permission to add people to a site.";
    if (options.siteCount === 0) return "Add a site first.";
    return null;
  }
  if (!can.invite) return "You do not have permission to invite people to the study.";
  if ((choice === "STUDY_LEAD" || choice === "PRINCIPAL_INVESTIGATOR") && !canGrantFullAccess(can)) return CANNOT_GRANT_MESSAGE;
  return null;
}

export type InviteForm = { email: string; choice: InviteChoice; advancedRoles?: StudyRole[]; studySiteId?: string | null; expiresInDays?: number };

/** Request body for POST /api/v1/studies/[id]/invitations, or an error sentence for the form. */
export function buildInviteBody(form: InviteForm): { body: Record<string, unknown> } | { error: string } {
  const email = form.email.trim();
  if (!email) return { error: "Enter the person's email address." };
  if (form.choice === "SITE_CONTACT") {
    if (!form.studySiteId) return { error: "Choose the site this person works at." };
    return { body: { email, studySiteId: form.studySiteId, siteRoles: toSiteRoles("SITE_CONTACT") } };
  }
  const roles = form.choice === "ADVANCED" ? Array.from(new Set(form.advancedRoles ?? [])) : toStudyRoles(form.choice);
  if (roles.length === 0) return { error: "Choose at least one role." };
  return { body: { email, roles } };
}

/** One entry per study with all of the person's roles in it (for the profile page). */
export function groupStudyRoles<S extends { id: string }>(memberships: Array<{ role: StudyRole; study: S }>): Array<{ study: S; roles: StudyRole[] }> {
  const byStudy = new Map<string, { study: S; roles: StudyRole[] }>();
  for (const membership of memberships) {
    const entry = byStudy.get(membership.study.id) ?? { study: membership.study, roles: [] };
    if (!entry.roles.includes(membership.role)) entry.roles.push(membership.role);
    byStudy.set(membership.study.id, entry);
  }
  return Array.from(byStudy.values());
}
