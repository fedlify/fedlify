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
    agentRuns?: number;
    releases?: number;
    sites?: number;
  };
};

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
