import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json } from "@/lib/json";
import { canAccessStudyActions, STUDY_ACTIONS } from "@/lib/rbac";

/** GET /api/v1/studies/[studyId]/permissions -> { can: Record<StudyAction, boolean> }. Never 403: no access is all false. */
export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  const can = await canAccessStudyActions(authResult.userId, studyId, STUDY_ACTIONS);
  return json({ can });
}
