import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { sessionId } = await params;

  const session = await prisma.templateAgentSession.findUnique({ where: { id: sessionId } });
  if (!session) return problem(404, "Session not found.", "not_found");

  if (session.requestedById !== authResult.userId && session.studyId) {
    try {
      await assertStudyAccess(authResult.userId, session.studyId, "runAgent");
    } catch (error) {
      if (isForbiddenError(error)) return problem(403, (error as Error).message, "forbidden");
      throw error;
    }
  } else if (session.requestedById !== authResult.userId) {
    return problem(403, "You do not have permission to access this session.", "forbidden");
  }

  return json({ session });
}
