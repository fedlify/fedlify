/**
 * The five plain roles shown when inviting or listing people. Client-safe: no server imports.
 * Each maps onto the detailed study roles (or, for the site contact, site roles on one site) that the
 * permission model in rbac.ts understands. The detailed roles stay available under "Advanced".
 */
import type { SiteRole, StudyRole } from "@prisma/client";

export type PlainRoleKey = "STUDY_LEAD" | "RESEARCHER" | "APPROVER" | "SITE_CONTACT" | "OBSERVER";

export type PlainRole = {
  key: PlainRoleKey;
  label: string;
  description: string;
  /** Study roles granted (empty for the site contact). */
  studyRoles: StudyRole[];
  /** Site roles granted on one site (empty for every role except the site contact). */
  siteRoles: SiteRole[];
};

export const PLAIN_ROLES: PlainRole[] = [
  {
    key: "STUDY_LEAD",
    label: "Study lead",
    description: "Runs the study: invites people, adds sites and makes the final decisions.",
    studyRoles: ["PRINCIPAL_INVESTIGATOR"],
    siteRoles: []
  },
  {
    key: "RESEARCHER",
    label: "Researcher",
    description: "Builds and tests the pipeline and starts runs.",
    studyRoles: ["DATA_SCIENTIST", "PIPELINE_DEVELOPER"],
    siteRoles: []
  },
  {
    key: "APPROVER",
    label: "Approver",
    description: "Reviews and approves pipelines, runs and model releases.",
    studyRoles: ["RELEASE_APPROVER", "CLINICAL_LEAD"],
    siteRoles: []
  },
  {
    key: "SITE_CONTACT",
    label: "Site contact",
    description: "Works at one hospital or clinic: installs the runner and gives the site sign-off for that site only.",
    studyRoles: [],
    siteRoles: ["SITE_ADMIN", "SITE_PI"]
  },
  {
    key: "OBSERVER",
    label: "Observer",
    description: "Can look at the study and its history but cannot change anything.",
    studyRoles: ["AUDITOR"],
    siteRoles: []
  }
];

export const STUDY_ROLE_LABELS: Record<StudyRole, string> = {
  PRINCIPAL_INVESTIGATOR: "Principal investigator",
  STUDY_OWNER: "Study owner",
  STUDY_COORDINATOR: "Study coordinator",
  CLINICAL_LEAD: "Clinical lead",
  ETHICS_REVIEWER: "Ethics reviewer",
  DATA_SCIENTIST: "Data scientist",
  PIPELINE_DEVELOPER: "Pipeline developer",
  PRIVACY_SECURITY_OFFICER: "Privacy and security officer",
  RELEASE_APPROVER: "Release approver",
  SITE_ADMIN: "Site administrator",
  AUDITOR: "Auditor"
};

export function plainRole(key: PlainRoleKey): PlainRole {
  return PLAIN_ROLES.find((role) => role.key === key) as PlainRole;
}

/** Study roles a plain role grants (empty for the site contact, which is a site role). */
export function toStudyRoles(plainKey: PlainRoleKey): StudyRole[] {
  return [...plainRole(plainKey).studyRoles];
}

/** Site roles a plain role grants (only the site contact has any). */
export function toSiteRoles(plainKey: PlainRoleKey): SiteRole[] {
  return [...plainRole(plainKey).siteRoles];
}

/** The plain role whose study roles match the set exactly, otherwise null (shown as "Custom"). */
export function plainRoleFor(studyRoles: readonly StudyRole[]): PlainRole | null {
  const set = new Set(studyRoles);
  if (set.size === 0) return null;
  return (
    PLAIN_ROLES.find((role) => role.studyRoles.length > 0 && role.studyRoles.length === set.size && role.studyRoles.every((item) => set.has(item))) ??
    null
  );
}

/**
 * The plain role that best describes a set of study roles that is not an exact match: anyone holding a lead role is a
 * Study lead (a lead already has every permission), and a person holding only some of a plain role's roles gets that role.
 */
export function closestPlainRole(studyRoles: readonly StudyRole[]): PlainRole | null {
  const exact = plainRoleFor(studyRoles);
  if (exact) return exact;
  const set = new Set(studyRoles);
  if (set.size === 0) return null;
  if (set.has("PRINCIPAL_INVESTIGATOR") || set.has("STUDY_OWNER")) return plainRole("STUDY_LEAD");
  return PLAIN_ROLES.find((role) => role.studyRoles.length > 0 && Array.from(set).every((item) => role.studyRoles.includes(item))) ?? null;
}

/** Label for a person's study roles: the closest plain role name, or "Custom". The detailed labels are given when the match is not exact. */
export function describeStudyRoles(studyRoles: readonly StudyRole[]): { label: string; detail: string | null } {
  if (plainRoleFor(studyRoles)) return { label: plainRoleFor(studyRoles)!.label, detail: null };
  const detail = Array.from(new Set(studyRoles)).map((role) => STUDY_ROLE_LABELS[role]).join(", ") || null;
  return { label: closestPlainRole(studyRoles)?.label ?? "Custom", detail };
}

/** True when the set of site roles matches the plain "Site contact". */
export function isSiteContact(siteRoles: readonly SiteRole[]): boolean {
  const target = plainRole("SITE_CONTACT").siteRoles;
  const set = new Set(siteRoles);
  return set.size === target.length && target.every((role) => set.has(role));
}
