/**
 * GET /api/v1/studies/[studyId]/preflight?kind=publish|run&projectId=...
 *
 * The checklist for Publish or Start run, as the server would decide it right now: { ok, items }.
 * The publish and run-start routes use the same function, so this list and their refusals always agree.
 * For a run, optional studySiteIds (comma separated), pipelineVersionId and minClients narrow the check. For a publish, an optional commit says which saved commit would be published.
 */

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { loadPreflight } from "@/lib/preflight-data";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const query = new URL(request.url).searchParams;
  const kind = query.get("kind");
  if (kind !== "publish" && kind !== "run") return problem(400, "Choose what to check: kind=publish or kind=run.", "invalid_kind");

  const minClients = Number(query.get("minClients"));
  const result = await loadPreflight(studyId, kind, {
    projectId: query.get("projectId"),
    publisherId: authResult.userId,
    pipelineVersionId: query.get("pipelineVersionId"),
    commit: /^[a-f0-9]{7,64}$/i.test(query.get("commit") ?? "") ? query.get("commit") : null,
    studySiteIds: query.get("studySiteIds")?.split(",").filter(Boolean),
    minClients: Number.isInteger(minClients) && minClients > 0 ? minClients : null
  });
  return json(result);
}
