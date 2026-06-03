import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/api";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { assertStudyAccess, isForbiddenError } from "@/lib/rbac";

type Params = { params: Promise<{ studyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;
  const { studyId } = await params;

  try {
    await assertStudyAccess(authResult.userId, studyId, "runAgent");
  } catch (error) {
    if (isForbiddenError(error)) return problem(403, (error as Error).message, "forbidden");
    throw error;
  }

  const raw = await prisma.templateAgentSession.findMany({
    where: { studyId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      mode: true,
      status: true,
      createdAt: true,
      intake: true
    }
  });

  const sessions = raw.map((s) => {
    const intake = (s.intake ?? {}) as Record<string, unknown>;
    const label =
      (intake.templateName as string | undefined)?.trim() ||
      ((intake.agentRequest as string | undefined)?.slice(0, 60)?.trim()) ||
      s.mode.replace(/_/g, " ").toLowerCase();
    return {
      id: s.id,
      mode: s.mode,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      label
    };
  });

  return json({ sessions });
}
