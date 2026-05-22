export const STUDY_WORKSPACE_SECTIONS = [
  {
    key: "overview",
    label: "Summary",
    title: "Study summary",
    subtitle: "Review lifecycle status, participant sites, pipeline versions, federated runs, and model releases."
  },
  {
    key: "protocol",
    label: "Protocol",
    title: "Study protocol",
    subtitle: "Define the study design, ethics decision, governed documents, participant sites, and activation readiness."
  },
  {
    key: "sites",
    label: "Sites & Data",
    title: "Sites and data",
    subtitle: "Register institutions, review site-local data profiles, and track readiness for federated participation."
  },
  {
    key: "team",
    label: "Team & Access",
    title: "Team and access",
    subtitle: "Manage study members, role-scoped invitations, and site-aware access."
  },
  {
    key: "pipeline",
    label: "Pipeline",
    title: "Pipeline",
    subtitle: "Select approved template sources, create study pipeline versions, validate commits, and approve immutable runnable versions."
  },
  {
    key: "run",
    label: "Run",
    title: "Federated runs",
    subtitle: "Provision the aggregator, monitor connected sites, submit approved pipeline versions, and inspect runtime events."
  },
  {
    key: "results",
    label: "Results & Releases",
    title: "Results and releases",
    subtitle: "Review trained model releases separately from code and startup-kit releases."
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
