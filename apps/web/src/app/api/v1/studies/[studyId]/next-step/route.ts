/**
 * GET /api/v1/studies/[studyId]/next-step
 *
 * The six study phases with their status, and which one needs attention now: { current, steps }.
 * Actions are limited to what the signed-in person may do.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { loadStudySteps } from "@/lib/next-step-data";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  return json(await loadStudySteps(studyId, authResult.userId));
}
