/** Database side of Study questions, shared by the requirements routes. */
import { prisma } from "@/lib/prisma";
import { studyQuestionsStrict } from "@/lib/runtime-config";
import { buildChecklist, type ChecklistPayload, type StoredQuestionRow } from "@/lib/study-questions";

export async function loadQuestionRows(studyId: string): Promise<StoredQuestionRow[]> {
  return (await prisma.requirementResponse.findMany({ where: { studyId } })) as StoredQuestionRow[];
}

/** The whole checklist as the screen needs it: rows, names, counts and the confirmation state. */
export async function loadChecklist(studyId: string, rows?: StoredQuestionRow[]): Promise<ChecklistPayload> {
  const [stored, study] = await Promise.all([
    rows ? Promise.resolve(rows) : loadQuestionRows(studyId),
    prisma.study.findUnique({ where: { id: studyId }, select: { specificationConfirmedAt: true, specificationConfirmedById: true } })
  ]);
  const ids = [...new Set([study?.specificationConfirmedById, ...stored.map((row) => row.confirmedById)].filter((id): id is string => Boolean(id)))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
  const names = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || "A team member"]));
  return buildChecklist({
    rows: stored,
    names,
    specification: { confirmedAt: study?.specificationConfirmedAt, confirmedById: study?.specificationConfirmedById },
    strict: studyQuestionsStrict()
  });
}

/** Any change to an answer ends the confirmation. Returns true when there was one to clear. */
export async function clearSpecificationConfirmation(studyId: string): Promise<boolean> {
  const result = await prisma.study.updateMany({
    where: { id: studyId, specificationConfirmedAt: { not: null } },
    data: { specificationConfirmedAt: null, specificationConfirmedById: null, specificationHash: null }
  });
  return result.count > 0;
}
