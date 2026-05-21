import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ensureStudyGiteaWorkspace } from "@/lib/gitea-workspaces";
import { json, problem } from "@/lib/json";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const { studyId } = await params;
  try {
    await assertStudyAccess(authResult.userId, studyId, "manage");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const workspace = await ensureStudyGiteaWorkspace({ studyId, userId: authResult.userId });

  await audit({
    actorUserId: authResult.userId,
    studyId,
    action: "study.gitea_workspace.ensure",
    targetType: "GiteaWorkspace",
    targetId: workspace.id,
    metadata: { owner: workspace.owner, status: workspace.status, url: workspace.url },
    request
  });

  return json({ workspace });
}
