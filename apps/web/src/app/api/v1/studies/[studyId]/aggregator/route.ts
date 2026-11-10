/**
 * GET /api/v1/studies/[studyId]/aggregator
 *
 * Everything the study's pipeline view needs in one call: the published aggregator (hostname, version,
 * publish status), which sites are actually connected to it, published versions, and recent runs.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { loadAggregatorOverview } from "@/lib/aggregator-overview";
import { json, problem } from "@/lib/json";
import { assertStudyAccess, canAccessStudyActions, isForbiddenError } from "@/lib/rbac";

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

  // What this person may do on the Code & run page, so the buttons they cannot use are not offered.
  const [overview, can] = await Promise.all([loadAggregatorOverview(studyId), canAccessStudyActions(authResult.userId, studyId, ["approvePipeline", "submitJob"] as const)]);
  return json({ ...overview, can });
}
