export const STUDY_WORKSPACE_SECTIONS = [
  {
    key: "overview",
    label: "Summary",
    title: "Study summary",
    subtitle: "Where this study stands and what to do next."
  },
  {
    key: "protocol",
    label: "Study setup",
    title: "Study setup",
    subtitle: "The study's details, ethics decision, documents and questions."
  },
  {
    key: "sites",
    label: "Sites",
    title: "Sites",
    subtitle: "The institutions in this study, with each site's kit, runner, code version and sign-off."
  },
  {
    key: "team",
    label: "Team",
    title: "Team and access",
    subtitle: "The people who work on this study and what each of them can do."
  },
  {
    key: "pipeline",
    label: "Code & run",
    title: "Code & run",
    subtitle: "Write and save pipeline code, publish a version, release site kits, and start a run across all sites."
  },
  {
    key: "run",
    label: "Code & run",
    title: "Code & run",
    subtitle: "Write and save pipeline code, publish a version, release site kits, and start a run across all sites."
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
  // Every ?section=results URL redirects, including ones with &detail=; the old result detail views no longer exist.
  results: (studyId) => `/studies/${studyId}/runs`
};

export type StudyNavKey = "overview" | "protocol" | "sites" | "team" | "code" | "results" | "audit";

/** The sidebar: Summary, Study setup, Sites, Team, Code & run, Results, Audit. One item per destination. */
export const STUDY_NAV_ITEMS: ReadonlyArray<{ key: StudyNavKey; label: string }> = [
  { key: "overview", label: "Summary" },
  { key: "protocol", label: "Study setup" },
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

/**
 * Which sidebar a person gets. `site-only`: they work at a site and have no study of their own, so the only entry is
 * "My site". `both`: the study sidebar plus an extra "My site" entry. `study`: the study sidebar (also the fallback
 * when the account details could not be loaded).
 */
export type SidebarMode = "study" | "site-only" | "both";

export function sidebarMode(me: { landing?: string | null; sites?: unknown[] | null } | null | undefined): SidebarMode {
  if (!me) return "study";
  if (me.landing === "/my-site") return "site-only";
  return (me.sites?.length ?? 0) > 0 ? "both" : "study";
}

/** The sidebar entry that "My site" highlights for a pathname. */
export function isMySitePath(pathname: string): boolean {
  return pathname === "/my-site" || pathname.startsWith("/my-site/") || pathname.startsWith("/sites/");
}

/** The three tabs of Study setup. */
export type StudySetupTab = "details" | "ethics" | "requirements";

/**
 * Which tab a link (`?section=protocol&tab=...`) opens. Links from before the simplification keep working: `documents`
 * now lives on the ethics tab, `metadata` and `details` are the details tab, and `review` (the removed Progress tab)
 * and anything unknown return null, which means "open the first tab that is not finished".
 */
export function studySetupTabFromLink(value?: string | null): StudySetupTab | null {
  if (value === "details" || value === "metadata") return "details";
  if (value === "ethics" || value === "documents") return "ethics";
  if (value === "requirements" || value === "questions") return "requirements";
  return null;
}

/** The first tab with something left to do; the details tab when everything is done. */
export function firstIncompleteSetupTab(done: { details: boolean; ethics: boolean; questions: boolean }): StudySetupTab {
  if (!done.details) return "details";
  if (!done.ethics) return "ethics";
  if (!done.questions) return "requirements";
  return "details";
}
