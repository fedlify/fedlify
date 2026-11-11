export type StudyDetailKind = "ethics" | "document";

export type StudyDetailState = {
  kind: StudyDetailKind;
  id: string;
};

const detailKinds = new Set<StudyDetailKind>(["ethics", "document"]);

export function parseStudyDetailParam(value?: string | null): StudyDetailState | null {
  if (!value) return null;
  const [kind, ...idParts] = value.split(":");
  const id = idParts.join(":");
  if (!detailKinds.has(kind as StudyDetailKind) || !id) return null;
  return { kind: kind as StudyDetailKind, id };
}

export function serializeStudyDetailParam(detail: StudyDetailState): string {
  return `${detail.kind}:${detail.id}`;
}
