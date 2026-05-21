import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

export async function GET(_request: NextRequest, context: { params: Promise<{ studyId: string }> }) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await context.params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "read");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, error.message, "forbidden");
    throw error;
  }

  const modelReleases = await prisma.modelRelease.findMany({
    where: { studyId },
    include: {
      artifacts: true,
      sourceResult: {
        include: {
          job: {
            include: {
              pipelineVersion: { include: { project: true } }
            }
          }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return json({ modelReleases });
}

