export const SELECTED_STUDY_STORAGE_KEY = "fedlify:selectedStudyId";
export const SELECTED_STUDY_EVENT = "fedlify:selectedStudyChanged";

export type StudyListStatusFilter = "all" | "active" | "archived";

export type StudySummary = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  updatedAt?: string;
  organization?: { id?: string; name: string };
  ethics?: Array<{ status: string }>;
  _count?: {
    members?: number;
    documents?: number;
    sites?: number;
  };
};

/**
 * A second line for studies whose titles are the same, so the selector never shows two identical rows: the
 * workspace the study belongs to, then its status, then the start of its id. Null for a title nobody else uses.
 */
export function studyNameHints(studies: Array<Pick<StudySummary, "id" | "title" | "status" | "organization">>): Map<string, string | null> {
  const key = (title: string) => title.trim().toLowerCase();
  const byTitle = new Map<string, typeof studies>();
  for (const study of studies) byTitle.set(key(study.title), [...(byTitle.get(key(study.title)) ?? []), study]);
  const hints = new Map<string, string | null>();
  for (const group of byTitle.values()) {
    if (group.length === 1) {
      hints.set(group[0].id, null);
      continue;
    }
    const status = (study: (typeof group)[number]) => (study.status === "ACTIVE" ? "Active" : study.status === "DRAFT" ? "Draft" : study.status.charAt(0) + study.status.slice(1).toLowerCase());
    const candidates = [
      (study: (typeof group)[number]) => study.organization?.name ?? "",
      (study: (typeof group)[number]) => [study.organization?.name, status(study)].filter(Boolean).join(" · "),
      (study: (typeof group)[number]) => [study.organization?.name, status(study), study.id.slice(-6)].filter(Boolean).join(" · ")
    ];
    const pick = candidates.find((make) => new Set(group.map(make)).size === group.length && group.every((study) => make(study))) ?? candidates[2];
    for (const study of group) hints.set(study.id, pick(study));
  }
  return hints;
}

export function isArchivedStudy(study: Pick<StudySummary, "status">): boolean {
  return study.status === "ARCHIVED";
}

export function matchesStudyStatusFilter(study: Pick<StudySummary, "status">, filter: StudyListStatusFilter): boolean {
  if (filter === "archived") return isArchivedStudy(study);
  if (filter === "active") return !isArchivedStudy(study);
  return true;
}

export function chooseSelectedStudy<T extends StudySummary>(studies: T[], storedStudyId?: string | null): T | null {
  if (storedStudyId) {
    const stored = studies.find((study) => study.id === storedStudyId && !isArchivedStudy(study));
    if (stored) return stored;
  }

  return studies.find((study) => !isArchivedStudy(study)) ?? studies[0] ?? null;
}

export function resolveUnavailableStudyTarget<T extends StudySummary>(
  studies: T[],
  currentStudyId: string,
  section = "overview"
): { href: string; studyId: string | null } {
  const selected = chooseSelectedStudy(studies, null);
  if (!selected || selected.id === currentStudyId) return { href: "/studies/manage", studyId: null };

  const params = new URLSearchParams();
  if (section !== "overview") params.set("section", section);

  const query = params.toString();
  return {
    href: `/studies/${selected.id}${query ? `?${query}` : ""}`,
    studyId: selected.id
  };
}
