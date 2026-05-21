import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function GET(request: NextRequest) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const scope = request.nextUrl.searchParams.get("scope") ?? "public";
  const studyId = request.nextUrl.searchParams.get("studyId") ?? undefined;

  if ((scope === "study" || scope === "all") && !studyId) {
    return problem(400, "Study template catalog requests require studyId.", "study_required");
  }

  if ((scope === "study" || scope === "all") && studyId) {
    try {
      await assertStudyAccess(authResult.userId, studyId, "read");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  }

  const where: Prisma.PipelineTemplateWhereInput =
    scope === "study"
      ? { active: true, scope: "STUDY_TEMPLATE", studyId }
      : scope === "all" && studyId
        ? { active: true, OR: [{ scope: "PUBLIC_TEMPLATE" }, { scope: "STUDY_TEMPLATE", studyId }] }
        : { active: true, scope: "PUBLIC_TEMPLATE" };

  const templates = await prisma.pipelineTemplate.findMany({
    where,
    include: {
      currentApprovedVersion: true,
      templateVersions: { orderBy: { createdAt: "desc" }, take: 10 },
      templateProposals: { orderBy: { createdAt: "desc" }, take: 5 }
    },
    orderBy: [{ framework: "asc" }, { name: "asc" }]
  });

  return json({ templates });
}
