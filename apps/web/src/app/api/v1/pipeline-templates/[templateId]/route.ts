import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function GET(_request: NextRequest, context: { params: Promise<{ templateId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { templateId } = await context.params;

  const template = await prisma.pipelineTemplate.findUnique({
    where: { id: templateId },
    include: {
      currentApprovedVersion: true,
      templateVersions: { orderBy: { createdAt: "desc" } },
      templateProposals: { include: { requestedBy: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "desc" } },
      projects: { select: { id: true, name: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 10 }
    }
  });
  if (!template) return problem(404, "Pipeline template not found.", "not_found");
  if (template.scope === "STUDY_TEMPLATE" && template.studyId) {
    try {
      await assertStudyAccess(authResult.userId, template.studyId, "read");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
      throw error;
    }
  }
  return json({ template });
}
