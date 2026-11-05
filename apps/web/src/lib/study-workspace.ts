export const STUDY_WORKSPACE_SECTIONS = [
  {
    key: "overview",
    label: "Summary",
    title: "Study summary",
    subtitle: "Review lifecycle status, participant sites, pipeline versions, runs, and model releases."
  },
  {
    key: "protocol",
    label: "Protocol",
    title: "Study protocol",
    subtitle: "Define the study design, ethics decision, governed documents, participant sites, and activation readiness."
  },
  {
    key: "sites",
    label: "Sites",
    title: "Sites",
    subtitle: "Register institutions, review site-local data profiles, and track readiness for federated participation."
  },
  {
    key: "team",
    label: "Team",
    title: "Team and access",
    subtitle: "Manage study members, role-scoped invitations, and site-aware access."
  },
  {
    key: "pipeline",
    label: "Code & run",
    title: "Code & run",
    subtitle: "Write and save pipeline code, publish a version, release site kits, and start a federated run."
  },
  {
    key: "run",
    label: "Code & run",
    title: "Code & run",
    subtitle: "Write and save pipeline code, publish a version, release site kits, and start a federated run."
  },
  {
    key: "results",
    label: "Results",
    title: "Results",
    subtitle: "Review the model releases produced by this study's runs."
  },
  {
    key: "audit",
    label: "Audit",
    title: "Audit log",
    subtitle: "Review study-scoped events for access, governance, artifacts, and release decisions."
  }
] as const;

export type StudyWorkspaceSection = (typeof STUDY_WORKSPACE_SECTIONS)[number]["key"];

export function normalizeStudyWorkspaceSection(value?: string | null): StudyWorkspaceSection {
  return STUDY_WORKSPACE_SECTIONS.some((section) => section.key === value)
    ? (value as StudyWorkspaceSection)
    : "overview";
}

export function getStudyWorkspaceSection(sectionKey: StudyWorkspaceSection) {
  return STUDY_WORKSPACE_SECTIONS.find((section) => section.key === sectionKey) ?? STUDY_WORKSPACE_SECTIONS[0];
}

export function studySectionHref(studyId: string, section: StudyWorkspaceSection = "overview") {
  return section === "overview" ? `/studies/${studyId}` : `/studies/${studyId}?section=${section}`;
}

/**
 * Where a summary card or next-action button should send the user. The legacy `pipeline` and `run` sections are
 * superseded by the Code & run workspace, so they resolve there; every other section keeps its section URL.
 */
export function studyActionHref(studyId: string, section: StudyWorkspaceSection = "overview") {
  if (section === "results") return `/studies/${studyId}/runs`;
  return section === "pipeline" || section === "run" ? `/studies/${studyId}/projects` : studySectionHref(studyId, section);
}

/** Legacy sections that no longer have a page of their own, mapped to their replacement route. Mirrored in next.config.mjs. */
export const LEGACY_SECTION_REDIRECTS: Record<string, (studyId: string) => string> = {
  pipeline: (studyId) => `/studies/${studyId}/projects`,
  run: (studyId) => `/studies/${studyId}/projects`,
  audit: (studyId) => `/studies/${studyId}/audit`,
  // Only the list redirects; ?section=results&detail=... (a legacy record view) still renders on the study page.
  results: (studyId) => `/studies/${studyId}/runs`
};

export type StudyNavKey = "overview" | "protocol" | "sites" | "team" | "code" | "results" | "audit";

/** The sidebar: Summary, Protocol, Sites, Team, Code & run, Results, Audit. One item per destination. */
export const STUDY_NAV_ITEMS: ReadonlyArray<{ key: StudyNavKey; label: string }> = [
  { key: "overview", label: "Summary" },
  { key: "protocol", label: "Protocol" },
  { key: "sites", label: "Sites" },
  { key: "team", label: "Team" },
  { key: "code", label: "Code & run" },
  { key: "results", label: "Results" },
  { key: "audit", label: "Audit" }
];

export function studyNavHref(studyId: string, key: StudyNavKey) {
  if (key === "code") return `/studies/${studyId}/projects`;
  if (key === "audit") return `/studies/${studyId}/audit`;
  if (key === "results") return `/studies/${studyId}/runs`;
  return studySectionHref(studyId, key);
}

/** Route-based sidebar selection. Query sections only decide the highlight on the study page itself. */
export function activeStudyNavKey(pathname: string, section: StudyWorkspaceSection): StudyNavKey | null {
  if (!pathname.startsWith("/studies/") || pathname === "/studies/manage") return null;
  const sub = /^\/studies\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
  if (sub === "projects" || sub === "pipeline-agent") return "code";
  if (sub === "audit") return "audit";
  if (sub === "runs") return "results";
  if (section === "pipeline" || section === "run") return "code";
  return section;
}
